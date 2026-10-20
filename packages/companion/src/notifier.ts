/** A desktop notification. It never opens a window or takes focus; a click or a button is the member's choice. */
export interface DesktopNotification {
  title: string
  body: string
  /** Stays on screen until dismissed. */
  sticky: boolean
  buttons: string[]
}

export interface NotificationHandlers {
  click(): void
  action(index: number): void
}

export interface DesktopNotifier {
  show(n: DesktopNotification, on: NotificationHandlers): void
}
