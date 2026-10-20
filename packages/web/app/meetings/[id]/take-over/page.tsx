import type { Metadata } from 'next'
import { ControlPage } from '../control-page'
import { ControlPanel } from '../control-panel'

export const metadata: Metadata = { title: 'Take over' }

export default async function TakeOverPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <ControlPage id={id} mode="take-over" panel={<ControlPanel id={id} mode="take-over" />} />
}
