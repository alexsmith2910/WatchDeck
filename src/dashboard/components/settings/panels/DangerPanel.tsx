/**
 * Danger zone — hard reset.
 *
 * Wipes every `mx_` collection, clears the disk buffer and in-memory state,
 * then emits a `system:reset` SSE event so connected dashboards reload. The
 * confirmation UI requires the user to type the literal phrase
 * `RESET EVERYTHING` AND tick the acknowledgement checkbox — matches the
 * backend check in `POST /admin/reset`.
 *
 *   POST /admin/reset
 */
import { useState } from 'react'
import { Button, Spinner, cn } from '@heroui/react'
import { Icon } from '@iconify/react'
import { SectionHead } from '../../endpoint-detail/primitives'
import { inputClass, errorInputClass } from '../../endpoint-detail/SettingsTab'
import { useApi } from '../../../hooks/useApi'
import { toast } from '../../../ui/toast'

const CONFIRM_PHRASE = 'RESET EVERYTHING'

interface ClearedCounts {
  endpoints?: number
  checks?: number
  incidents?: number
  notification_log?: number
  notification_channels?: number
  [key: string]: number | undefined
}

export function DangerPanel() {
  const { request } = useApi()
  const [confirmPhrase, setConfirmPhrase] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const phraseOk = confirmPhrase === CONFIRM_PHRASE
  const canSubmit = phraseOk && acknowledged && !submitting
  const phraseError = confirmPhrase.length > 0 && !phraseOk

  const reset = async () => {
    setSubmitting(true)
    const res = await request<{ data: { cleared: ClearedCounts } }>('/admin/reset', {
      method: 'POST',
      body: { confirm: CONFIRM_PHRASE },
    })
    if (res.status >= 400) {
      setSubmitting(false)
      toast.error('Reset Failed', { description: `HTTP ${res.status}` })
      return
    }
    const cleared = res.data?.data?.cleared ?? {}
    const total = Object.values(cleared).reduce((a: number, b) => a + (b ?? 0), 0)
    toast.success('Reset complete', {
      description: `${total.toLocaleString()} records removed. Reloading…`,
    })
    // Give the toast a beat before the full reload so the user sees the
    // confirmation, then hard-reload so every component re-fetches clean.
    window.setTimeout(() => {
      window.location.reload()
    }, 1500)
  }

  return (
    <div className="rounded-xl border border-wd-danger/40 bg-wd-danger/5 p-5">
      <SectionHead
        icon="solar:danger-triangle-linear"
        title="Danger zone"
        sub="Irreversible actions. Be sure you know what you're doing."
      />

      <div className="flex flex-col gap-3">
        <div>
          <div className="text-[12.5px] font-semibold text-wd-danger">Hard reset WatchDeck</div>
          <div className="text-[11.5px] text-wd-muted mt-0.5">
            Deletes every endpoint, check, incident, notification channel, delivery log entry,
            runtime setting override, and historical aggregation. The disk buffer is emptied
            and in-memory caches are cleared.
          </div>
        </div>

        <ul className="text-[11.5px] text-wd-muted space-y-0.5 pl-4 list-disc">
          <li>Endpoints and every attached check and incident.</li>
          <li>Notification channels, delivery log, mutes, and preferences.</li>
          <li>Runtime overrides in <span className="font-mono text-foreground">mx_settings</span>.</li>
          <li>Disk buffer file at <span className="font-mono text-foreground">~/.watchdeck/buffer.jsonl</span>.</li>
          <li>System health snapshot and internal incidents.</li>
        </ul>

        <div className="rounded-lg border border-wd-warning/30 bg-wd-warning/5 px-3 py-2 text-[11.5px] text-wd-warning flex items-start gap-2">
          <Icon icon="solar:shield-warning-bold" width={15} className="mt-0.5 shrink-0" />
          <span>
            Config in <span className="font-mono">watchdeck.config.js</span> and environment
            variables are <b>not</b> touched. The process stays running and accepts new endpoints
            immediately after the wipe.
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-[11.5px] font-medium text-foreground">
            Type <span className="font-mono text-wd-danger">{CONFIRM_PHRASE}</span> to confirm
          </label>
          <input
            value={confirmPhrase}
            onChange={(e) => setConfirmPhrase(e.target.value)}
            placeholder={CONFIRM_PHRASE}
            className={cn(inputClass, 'max-w-sm', phraseError && errorInputClass)}
            autoComplete="off"
            spellCheck={false}
          />
          {phraseError && (
            <span className="text-[11px] text-wd-danger inline-flex items-center gap-1">
              <Icon icon="solar:danger-triangle-outline" width={12} />
              Phrase does not match.
            </span>
          )}
        </div>

        <button
          type="button"
          role="checkbox"
          aria-checked={acknowledged}
          onClick={() => setAcknowledged((v) => !v)}
          className="inline-flex items-center gap-2.5 text-[12px] text-foreground cursor-pointer select-none group w-fit"
        >
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex items-center justify-center w-[18px] h-[18px] rounded-md border transition-colors shrink-0',
              acknowledged
                ? 'bg-wd-danger/90 border-wd-danger text-white'
                : 'bg-wd-surface border-wd-border/60 group-hover:border-wd-danger/50',
            )}
          >
            {acknowledged && <Icon icon="solar:check-read-linear" width={12} />}
          </span>
          I understand this cannot be undone.
        </button>

        <div className="pt-2">
          <Button
            size="sm"
            variant="outline"
            className="!rounded-lg !border-wd-danger/50 !text-wd-danger hover:!bg-wd-danger/10"
            onPress={() => void reset()}
            isDisabled={!canSubmit}
          >
            {submitting ? (
              <Spinner size="sm" />
            ) : (
              <Icon icon="solar:trash-bin-trash-bold" width={16} />
            )}
            Hard reset WatchDeck
          </Button>
        </div>
      </div>
    </div>
  )
}
