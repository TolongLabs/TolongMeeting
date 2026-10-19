import type { ControlCommand } from '@tm/core'

export interface CommandHandlers {
  leave(): Promise<void>
  stop(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
}

/**
 * Runs the commands of one reply in order. `leave_now` and `take_over` both mean "leave" (until plan 06 gives
 * `take_over` its own meaning) and leave runs once per batch. A handler that throws stops the batch and the error goes
 * to the caller.
 */
export async function dispatchCommands(cmds: ControlCommand[], h: CommandHandlers): Promise<void> {
  let left = false
  for (const cmd of cmds) {
    switch (cmd) {
      case 'leave_now':
      case 'take_over':
        if (!left) await h.leave()
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
