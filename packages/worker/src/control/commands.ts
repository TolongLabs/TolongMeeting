import type { ControlCommand } from '@tm/core'

export interface CommandHandlers {
  leave(command: 'leave_now' | 'take_over'): Promise<void>
  stop(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
}

/**
 * Runs the commands of one reply in order. `leave_now` and `take_over` both mean "leave", and leave runs once per
 * batch: as `take_over` when the batch holds one (the member opens the meeting after the bot leaves), else as
 * `leave_now`, at the place of the first of the two. A handler that throws stops the batch and the error goes to the
 * caller.
 */
export async function dispatchCommands(cmds: ControlCommand[], h: CommandHandlers): Promise<void> {
  const leaveAs = cmds.includes('take_over') ? 'take_over' : 'leave_now'
  let left = false
  for (const cmd of cmds) {
    switch (cmd) {
      case 'leave_now':
      case 'take_over':
        if (!left) await h.leave(leaveAs)
        left = true
        break
      case 'stop':
        await h.stop()
        break
      case 'pause_for_signin':
        await h.pause()
        break
      case 'resume_after_signin':
        await h.resume()
        break
    }
  }
}
