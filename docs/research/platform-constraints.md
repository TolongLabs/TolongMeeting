# Platform constraints

What Zoom, Microsoft Teams and Google Meet allowed automated participants to do as of 20 October 2026, plus what an automated browser needs to submit sign-in-restricted forms and which QR decoders suit screen shares. Collected for the TolongMeeting design; sources marked forum or vendor are secondary and unverified. Re-check before building.

Contents:

1.  [Zoom](#zoom)
1.  [Microsoft Teams](#microsoft-teams)
1.  [Google Meet](#google-meet)
1.  [Across platforms](#across-platforms)
1.  [Forms](#forms)
1.  [QR decoding](#qr-decoding)
1.  [Biggest risks found](#biggest-risks-found)
1.  [How the design responds](#how-the-design-responds)

## Zoom

- **Official SDK bots need approval**: from 2 March 2026, Meeting SDK apps that join meetings outside their own account must be authorised with OBF, ZAK or RTMS tokens; apps lacking the `user:read:token` scope must add it and go through review ([Zoom blog](https://developers.zoom.us/blog/transition-to-obf-token-meetingsdk-apps/), [policy changelog](https://developers.zoom.us/changelog/platform/meeting-sdk-policy-announcement/)). A third-party estimate puts review at 4 to 6 weeks. Internal apps used only within the developer's own account need no Marketplace submission.
- **Linux SDK**: version 6.7.5 (February 2026) restricted cross-account anonymous joins ([changelog](https://devforum.zoom.us/t/changelog-meeting-sdk-linux-6-7-5/142123)). A developer reported `AppCanNotAnonymousJoinMeeting` failures from about 7 July 2026 (forum).
- **Raw media**: a guest bot can't start recording itself without a host token; it calls `RequestLocalRecordingPrivilege`, which prompts the host (forum). Staff reportedly describe the raw-data licence as legacy ([Linux raw-data docs](https://developers.zoom.us/docs/meeting-sdk/linux/custom-ui/advanced-features/raw-data.md)).
- **Web-client guests**: Zoom has no official setting to block bots; an August 2026 community request asks for one ([community](https://community.zoom.com/meetings-2/we-need-a-setting-to-allow-admins-to-prohibits-bots-from-entering-or-attempting-to-enter-a-meeting-81681)). Joining as a guest through the web client worked on 19 October 2026.

## Microsoft Teams

- **Anonymous joins**: the organisation-wide toggle is being retired in favour of per-organiser policies. Anonymous users show as "Unverified", organisers can require an email one-time passcode (Teams Premium), and anonymous participants lose meeting chat before and after the meeting ([Microsoft Learn, updated 6 July 2026](https://learn.microsoft.com/en-us/microsoftteams/anonymous-users-in-meetings)). The lobby follows the bypass-lobby policy.
- **Bot detection**: message-centre notice MC1251206 (version 7, 22 September 2026). Teams detects external meeting-assistant bots, labels them in the lobby and lets organisers approve or deny them. Detection is on by default, and so is approval. General availability is due "by end of October 2026", and some bots may go undetected ([notice](https://mc.merill.net/message/MC1251206)).
- **Graph media bots**: application-hosted media needs the `Microsoft.Graph.Communications.Calls.Media` .NET library on Windows Server and admin-consented permissions ([overview](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/calls-meetings-bots-overview)).
- **Transcripts by API**: notice MC1393806 says apps without an admin-enabled transcript permission get access errors after enforcement in late July 2026 ([notice](https://mc.merill.net/message/MC1393806)).

## Google Meet

- **Meet Media API**: the guide states it no longer accepts new registrations ([guide](https://developers.google.cn/workspace/meet/media-api/guides/get-started), checked 1 October 2026). Scopes are restricted, server-side use needs a security assessment, and chat isn't covered.
- **Guest admission**: access levels are Open, Trusted and Restricted; Trusted lets members of the host's organisation in without knocking ([Google, 2023](https://workspaceupdates.googleblog.com/2023/06/simplified-access-controls-for-google-meet.html)). The safeguarded guest-admit flow (rolled out March and April 2026) adds a second review queue that defaults to deny ([Google, February 2026](https://workspaceupdates.googleblog.com/2026/02/safeguarded-guest-admit-flow-in-google-meet.html)). Vendors say bots land in that queue and need manual admission.

## Across platforms

- No official rule was found requiring bots to announce themselves. Zoom gates bots through tokens and review; Teams labels them.
- Common reasons bots get blocked: no OBF or ZAK authorisation (Zoom); anonymous join off or a waiting lobby (Teams); Teams detection with approval; denial in Meet's review queue; missing admin consent for Graph; tenant gating of the transcript API.
- Recording-consent law varies by jurisdiction and wasn't researched; neither were each platform's terms on automated participants in detail.

## Forms

- **Microsoft Forms**: no Forms-specific source was found. The default Entra sign-in frequency is a rolling 90-day window, which a tenant's Conditional Access can shorten, and multi-factor authentication applies (search snippet).
- **Google Forms**: the "Restrict to users in [organisation]" setting requires sign-in, and the owner can turn it off ([Google Admin Help](https://support.google.com/a/users/answer/9303071?hl=en)). A "record name" setting couldn't be verified.
- How long a saved browser session (for example a Playwright storage state) stays valid wasn't verified.

## QR decoding

- **ZXing-C++**: fastest in a vendor benchmark, at about 40 ms per image, but it found only 23.8% of codes in multi-code images ([Dynamsoft, vendor](https://www.dynamsoft.com/codepool/python-zxing-zbar-barcode.html)).
- **PyZBar (ZBar)**: 76.8% overall in the same benchmark. Dynamsoft reports 100% for rotations of 15 to 75 degrees.
- **ZBar against OpenCV's `QRCodeDetector`**: LearnOpenCV found ZBar about twice as fast and better at angles ([LearnOpenCV](https://learnopencv.com/opencv-qr-code-scanner-c-and-python)).
- **OpenCV's WeChat detector**: adds super-resolution for small codes ([LearnOpenCV](https://learnopencv.com/wechat-qr-code-scanner-in-opencv)).
- There is no head-to-head test on small, angled codes in screen shares. Benchmark on real frames.

## Biggest risks found

1.  The Meet Media API is closed to new registrations, and browser guests may be denied by default, needing a host to admit them each time.
1.  Zoom's official SDK route needs approved authorisation for meetings in other accounts.
1.  Teams bot detection with approval by default, tenant gating of transcripts, and the Windows and admin-consent requirements for media bots.
1.  Recording-consent law is unresearched, and platforms are actively labelling and blocking bots.
1.  Form automation is brittle under Conditional Access and MFA and may breach organisational policy; QR detection on small screen-share codes is unbenchmarked.

## How the design responds

- **Join as the member**, signed in through the web client, so neither the official SDKs nor guest queues apply in the normal case (decision 10).
- **The member signs in once and handles their own MFA**; the bot never stores passwords. When a session expires, the member is pinged.
- **Spike 1** tests university sign-ins from the server, with local mode as the fallback.
- **Spike 3** benchmarks QR decoding on real 1080p screen shares.
