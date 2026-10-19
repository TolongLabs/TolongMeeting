"""Create the sdc-hack OBS scene collection: Zoom meeting window + Zoom app audio only."""
import json
import os
import time

import obsws_python as obs

CFG = os.path.expandvars(r"%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json")


def client():
    pw = json.load(open(CFG))["server_password"]
    return obs.ReqClient(host="localhost", port=4455, password=pw, timeout=15)


def main():
    cl = client()
    if "sdc-hack" not in cl.get_scene_collection_list().scene_collections:
        cl.create_scene_collection("sdc-hack")
    else:
        cl.set_current_scene_collection("sdc-hack")
    time.sleep(3)
    cl = client()  # collection switch can drop pending requests; reconnect
    scene = cl.get_current_program_scene().current_program_scene_name
    inputs = {i["inputName"]: i["inputKind"] for i in cl.get_input_list().inputs}
    print("scene:", scene, "inputs:", inputs)

    # Global desktop/mic sources stay muted: only Zoom's own audio is recorded.
    for name, kind in inputs.items():
        if kind in ("wasapi_input_capture", "wasapi_output_capture"):
            cl.set_input_mute(name, True)
            print("muted", name)

    if "Zoom Meeting" not in inputs:
        cl.create_input(scene, "Zoom Meeting", "window_capture",
                        {"method": 2, "cursor": False, "client_area": True, "priority": 0}, True)
    if "Zoom Audio" not in inputs:
        cl.create_input(scene, "Zoom Audio", "wasapi_process_output_capture", {"priority": 2}, True)

    item = cl.get_scene_item_id(scene, "Zoom Meeting").scene_item_id
    cl.set_scene_item_transform(scene, item, {
        "positionX": 0, "positionY": 0, "boundsType": "OBS_BOUNDS_SCALE_INNER",
        "boundsWidth": 1920, "boundsHeight": 1080, "boundsAlignment": 0})

    for src in ("Zoom Meeting", "Zoom Audio"):
        items = cl.get_input_properties_list_property_items(src, "window").property_items
        print(f"--- {src} window choices:")
        for it in items:
            if "zoom" in it["itemValue"].lower():
                print("  ", it["itemValue"])


if __name__ == "__main__":
    main()
