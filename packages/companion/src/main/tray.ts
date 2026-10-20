import { join } from 'node:path'
import { Menu, nativeImage, nativeTheme, Tray } from 'electron'
import { buildTrayMenu, type TrayActions, type TrayModel } from './tray-menu'

/**
 * The tray icon and its menu. The icon is a single-colour glyph in two files: white for a dark taskbar, black for a
 * light one; the `@2x` files next to them are picked on high-DPI screens. The menu is rebuilt on every change.
 */
export class AppTray {
  private readonly tray: Tray

  constructor(
    private readonly assetsDir: string,
    private readonly actions: TrayActions,
    private model: TrayModel
  ) {
    this.tray = new Tray(this.icon())
    this.tray.setToolTip('TolongMeeting')
    nativeTheme.on('updated', () => this.tray.setImage(this.icon()))
    this.render()
  }

  update(model: TrayModel): void {
    this.model = model
    this.render()
  }

  destroy(): void {
    this.tray.destroy()
  }

  private icon(): Electron.NativeImage {
    const tone = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'white' : 'black'
    const image = nativeImage.createFromPath(join(this.assetsDir, `tray-${tone}.png`))
    if (image.isEmpty()) throw new Error(`the tray icon is missing: tray-${tone}.png`)
    return image
  }

  private render(): void {
    this.tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(this.model, this.actions)))
  }
}
