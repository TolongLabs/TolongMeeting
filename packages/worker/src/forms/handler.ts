import { join } from 'node:path'
import {
  applyFormTrigger,
  canonicalFormUrl,
  isTerminalFormState,
  newFormRecord,
  type FilledField,
  type FormRecord,
  type FormTrigger,
  type ResolvedForm,
  type StopReason
} from '@tm/core'
import type { Page } from 'playwright'
import { TabCloseFailedError, TabNotOnDeskError, OpenTimeoutError, openDeskTab, openForm } from './open'
import { buildDetailPool } from './details'
import { driverFor, FormStepError, type FormDriver } from './drivers'
import { formPing } from './pings'
import { exactLabelMatches, planPage, questionsForModel, verifyFill } from './plan'
import { looksLikeAttendance, orgRestricted } from './rules'
import { formEventData, saveFormRecord } from './store'
import { checkTrust } from './trust'
import { errorText } from './redact'
import type { Answer, FormContext, FormPage } from './types'

export const SUBMIT_DEADLINE_MS = 120_000
const MAX_PAGES = 30 // a guard against a form whose Next never ends
const TEXT_LIMIT = 120

// Cuts to TEXT_LIMIT UTF-16 code units (the record schema's limit), dropping a lone high surrogate left at the end.
function cut(text: string): string {
  if (text.length <= TEXT_LIMIT) return text
  const head = text.slice(0, TEXT_LIMIT)
  const last = head.charCodeAt(TEXT_LIMIT - 1)
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
}

// Emits an event. A failing emitter is reported on stderr in fixed text (an event's own message could carry a value)
// and never stops the run: the record on disk already holds what happened.
async function emitSafely(ctx: FormContext, type: 'form' | 'error' | 'alert', data: Record<string, unknown>) {
  try {
    await ctx.emitEvent(type, data)
  } catch {
    console.error(`[tm-worker] could not emit a ${type} event`)
  }
}

// How a run ended before the record could say so: the handler stops the run and returns the record as it stands.
class Stop extends Error {}

class FormRun {
  rec: FormRecord
  tab: Page | null = null
  private driver: FormDriver | null = null
  private deadline = 0

  constructor(
    private readonly f: ResolvedForm,
    private readonly ctx: FormContext
  ) {
    this.rec = ctx.previous ?? newFormRecord(f, ctx.cfg.occurrenceId)
  }

  private get cfg() {
    return this.ctx.cfg
  }

  // Applies a trigger, saves the record, emits the form event, and sends the state's ping if it has one.
  async apply(trigger: FormTrigger): Promise<void> {
    this.rec = applyFormTrigger(this.rec, trigger, new Date().toISOString())
    await saveFormRecord(this.cfg.dataDir, this.rec)
    await emitSafely(this.ctx, 'form', formEventData(this.rec))
    await this.sendPing()
  }

  // Sends the ping of the record's state, if it has one, and writes it into rec.pings. The log is updated in memory
  // before it is saved, so a failing save can never make recover() send the same ping twice.
  private async sendPing(): Promise<void> {
    const ping = formPing(this.rec, {
      entryName: this.cfg.entry.name,
      timeZone: this.cfg.entry.timeZone,
      links: this.ctx.links
    })
    if (ping === null) return
    await this.ctx.ping(ping)
    this.rec = { ...this.rec, pings: [...this.rec.pings, { state: this.rec.state, at: new Date().toISOString() }] }
    await saveFormRecord(this.cfg.dataDir, this.rec)
  }

  // Sends the ping of a terminal state whose ping never went out (the ping or a save threw before it was recorded).
  async ensurePing(): Promise<void> {
    const state = this.rec.state
    if (!isTerminalFormState(state)) return
    if (
      this.rec.pings.filter((p) => p.state === state).length >= this.rec.history.filter((h) => h.state === state).length
    ) {
      return
    }
    await this.sendPing()
  }

  async fail(reason: StopReason): Promise<never> {
    this.rec = { ...this.rec, reason }
    await this.apply('error')
    throw new Stop()
  }

  // Applies a trigger that ends the run in a terminal state.
  async finish(trigger: FormTrigger): Promise<never> {
    await this.apply(trigger)
    throw new Stop()
  }

  async run(): Promise<void> {
    await this.start()
    const kind = await this.open()
    if (kind === 'form') await this.apply('page_loaded')
    else if (kind === 'already_answered') await this.finish('already_answered_seen')
    else if (kind === 'closed') await this.fail('form_closed')
    else if (kind === 'no_access') await this.fail('no_access')
    else if (kind === 'captcha') await this.fail('captcha')
    else if (kind === 'unknown') await this.fail('unknown_page')
    else await this.fail('unexpected_error') // 'signin' and 'confirmation': sign-in handling is Task 12
    for (let n = 1; ; n++) {
      if (n > MAX_PAGES) await this.fail('unknown_page')
      if (await this.page(n)) return
    }
  }

  private async start(): Promise<void> {
    const seen = Date.parse(this.f.seenAt)
    // Without a readable time there is no deadline, and a missing deadline would let a stale form be submitted.
    if (Number.isNaN(seen)) throw new Error('the form has an unreadable seenAt, so its deadline cannot be set')
    this.deadline = seen + SUBMIT_DEADLINE_MS
    if (this.ctx.previous === null) {
      await this.apply('resolve_started')
      await this.apply('resolved')
    } else {
      this.rec = {
        ...applyFormTrigger(this.rec, 'trusted_candidate_seen', new Date().toISOString()),
        source: this.f.source,
        sender: this.f.sender,
        senderRole: this.f.senderRole,
        reason: null
      }
      await saveFormRecord(this.cfg.dataDir, this.rec)
      await emitSafely(this.ctx, 'form', formEventData(this.rec))
    }
    const decision = checkTrust(this.f, this.cfg.entry.trustedSenders)
    if (decision.trusted) {
      this.rec = { ...this.rec, trustReason: decision.reason }
      await this.apply('trusted')
    } else if (this.cfg.identity.organisation === null) {
      this.rec = { ...this.rec, reason: 'untrusted_source' }
      await this.finish('trust_failed')
    } else {
      await this.apply('trust_deferred')
    }
  }

  private async open() {
    try {
      this.tab = await openDeskTab(this.ctx.desk)
    } catch (error) {
      if (error instanceof TabNotOnDeskError) await this.fail('tab_not_on_desk')
      throw error
    }
    this.driver = await driverFor(this.f.provider)
    try {
      return await openForm(this.tab, canonicalFormUrl(this.f.finalUrl), this.driver)
    } catch (error) {
      if (error instanceof OpenTimeoutError) {
        await this.closeTab() // before anything else, so a slow page cannot go on loading
        await this.fail('open_timeout')
      }
      throw error
    }
  }

  // Inspects, fills and advances page n. True once the form has reached a terminal state.
  private async page(n: number): Promise<boolean> {
    const tab = this.tab!
    const driver = this.driver!
    const page = await this.read(n)
    if (n === 1) {
      this.rec = { ...this.rec, title: page.title }
      if (this.rec.trustReason === null) {
        if (orgRestricted(page.restriction, this.cfg.identity.organisation)) {
          this.rec = { ...this.rec, trustReason: 'org_restricted' }
        } else {
          this.rec = { ...this.rec, reason: 'not_org_restricted' }
          await this.finish('org_check_failed')
        }
      }
    }
    if (page.quiz) await this.finish('quiz_detected')
    if (n === 1 && !looksLikeAttendance(page, this.cfg.entry.attendanceKeywords)) {
      await this.finish('no_attendance_terms')
    }
    await this.apply('inspected')

    const pool = buildDetailPool(this.cfg)
    const exact = exactLabelMatches(page, pool)
    const toMatch = questionsForModel(page, exact)
    const model =
      toMatch.length > 0
        ? await this.ctx.matchLabels(
            toMatch,
            pool.map((d) => d.key)
          )
        : new Map<string, string>()
    const plan = planPage(page, pool, exact, model)
    if (plan.unmatchedRequired.length > 0) {
      this.rec = { ...this.rec, unmatched: plan.unmatchedRequired.map((q) => cut(q.label)) }
      await this.finish('unmatched_required')
    }
    await this.beforeDeadline()
    try {
      await driver.fill(tab, page, plan.answers)
      if (!verifyFill(plan, await driver.readPage(tab, n))) await this.fail('fill_failed')
    } catch (error) {
      if (error instanceof FormStepError)
        await this.stepFailed(error, error.code === 'not_a_form' ? 'unknown_page' : 'fill_failed')
      throw error
    }
    this.rec = { ...this.rec, fieldsFilled: [...this.rec.fieldsFilled, ...this.filled(n, page, plan.answers)] }
    await this.screenshot(page.hasSubmit ? 'filled.png' : `filled_${n}.png`)

    if (page.hasSubmit) {
      await this.submit()
      return true
    }
    if (page.hasNext) {
      try {
        await driver.next(tab)
      } catch (error) {
        if (error instanceof FormStepError)
          await this.stepFailed(error, error.code === 'not_a_form' ? 'unknown_page' : 'next_failed')
        throw error
      }
      await this.apply('next_page')
      return false
    }
    return await this.fail('unknown_page')
  }

  private async read(n: number): Promise<FormPage> {
    try {
      return await this.driver!.readPage(this.tab!, n)
    } catch (error) {
      if (error instanceof FormStepError && error.code === 'not_a_form') await this.stepFailed(error, 'unknown_page')
      throw error
    }
  }

  // A driver step that failed in a way the driver names: say why (redacted), then end the form with `reason`.
  private async stepFailed(error: FormStepError, reason: StopReason): Promise<never> {
    await emitSafely(this.ctx, 'error', {
      where: 'form_step',
      formId: this.rec.formId,
      code: error.code,
      message: errorText(this.cfg, error)
    })
    return this.fail(reason)
  }

  private async beforeDeadline(): Promise<void> {
    if (Date.now() > this.deadline) await this.fail('deadline')
  }

  private filled(n: number, page: FormPage, answers: Answer[]): FilledField[] {
    return answers.map((a) => ({
      page: n,
      question: cut(page.questions.find((q) => q.id === a.questionId)!.label),
      detailKey: a.detailKey,
      value: a.kind === 'text' ? a.value : a.option,
      via: a.via
    }))
  }

  private async screenshot(name: string): Promise<void> {
    const rel = `forms/${this.rec.formId}/${name}`
    await this.tab!.screenshot({ path: join(this.cfg.dataDir, rel), fullPage: true })
    this.rec = { ...this.rec, screenshots: [...this.rec.screenshots, rel] }
  }

  // The one irreversible step. The record says `submitting` on disk before the click, so a crash from here on is
  // recovered as maybe-submitted. After the click nothing is retried: every outcome but a confirmation is final.
  private async submit(): Promise<void> {
    if (this.rec.trustReason === null) throw new Error('refusing to submit a form that was never trusted')
    await this.beforeDeadline()
    // Only the click and what follows it may be maybe-submitted. A failed save here is a failure before the click.
    const before = this.rec
    try {
      await this.apply('submit_clicked')
    } catch (error) {
      this.rec = before
      throw error
    }
    try {
      await this.driver!.submit(this.tab!)
    } catch (error) {
      if (error instanceof FormStepError && (error.code === 'submit_failed' || error.code === 'not_a_form')) {
        await this.stepFailed(error, 'submit_failed')
      }
      throw error // submit_unconfirmed and anything unexpected: handled as maybe-submitted by the caller
    }
    const kind = await this.driver!.pageKind(this.tab!)
    if (kind === 'already_answered') await this.finish('already_answered_seen')
    if (kind !== 'confirmation') await this.fail('submit_unconfirmed')
    this.rec = { ...this.rec, submittedAt: new Date().toISOString() }
    await this.apply('confirmed')
    await this.screenshot('confirmation.png')
    await saveFormRecord(this.cfg.dataDir, this.rec)
  }

  // Closes the tab; one that stays open is reported and never reused.
  async closeTab(): Promise<void> {
    const tab = this.tab
    if (tab === null) return
    this.tab = null
    try {
      await tab.close()
    } catch (error) {
      if (!tab.isClosed()) throw new TabCloseFailedError('could not close the form tab', { cause: error })
    }
    if (!tab.isClosed()) throw new TabCloseFailedError('could not close the form tab: it is still open')
  }
}

// Handles one form from first sight to a terminal state. It never throws: whatever goes wrong ends in the record.
// (The one exception is a finalUrl that is not a URL: no record can exist for it.)
export async function handleForm(f: ResolvedForm, ctx: FormContext): Promise<FormRecord> {
  let run: FormRun
  try {
    run = new FormRun(f, ctx)
  } catch (error) {
    await emitSafely(ctx, 'error', { where: 'form_handler', message: errorText(ctx.cfg, error) })
    throw error
  }
  try {
    await run.run()
  } catch (error) {
    if (!(error instanceof Stop)) await recover(run, ctx, error)
  }
  try {
    await run.closeTab()
  } catch (error) {
    await emitSafely(ctx, 'alert', {
      kind: 'form_tab_not_closed',
      formId: run.rec.formId,
      message: errorText(ctx.cfg, error)
    })
  }
  return run.rec
}

// An unexpected exception: say so, and end the form as failed. Once Submit may have been clicked the form is
// maybe-submitted, never "unexpected". The terminal ping is sent even when the exception came from sending it.
async function recover(run: FormRun, ctx: FormContext, error: unknown): Promise<void> {
  const message = errorText(ctx.cfg, error)
  await emitSafely(ctx, 'error', { where: 'form_handler', formId: run.rec.formId, message })
  if (error instanceof TabCloseFailedError) {
    await emitSafely(ctx, 'alert', { kind: 'form_tab_not_closed', formId: run.rec.formId, message })
  }
  if (!isTerminalFormState(run.rec.state)) {
    try {
      await run.fail(run.rec.state === 'submitting' ? 'submit_unconfirmed' : 'unexpected_error')
    } catch (again) {
      if (!(again instanceof Stop)) {
        await emitSafely(ctx, 'error', {
          where: 'form_handler',
          formId: run.rec.formId,
          message: errorText(ctx.cfg, again)
        })
      }
    }
  }
  try {
    await run.ensurePing()
  } catch (again) {
    await emitSafely(ctx, 'error', {
      where: 'form_ping',
      formId: run.rec.formId,
      message: errorText(ctx.cfg, again)
    })
  }
}
