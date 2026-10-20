import type { Metadata } from 'next'
import { ControlPage } from '../control-page'
import { ControlPanel } from '../control-panel'

export const metadata: Metadata = { title: 'Make the bot leave' }

export default async function LeavePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ControlPage id={id} mode="leave" panel={<ControlPanel id={id} mode="leave" />} />
}
