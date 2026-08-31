import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import type { ApiKey } from '../../../../shared/types'

// #590: the backend has supported a per-key proxy override for a while
// (PATCH /api/keys/:id accepts proxyUrl, '' clears it, a set value overrides
// the global outbound proxy for exactly this key), but the UI only ever
// exposed the global switch plus per-platform bypass. That meant one toggle
// decided routing for every key of a platform — no way to send ZenMux
// through socks5 and inferX through http while keeping the same gateway.
//
// Mirrors the ModelScopeDialog pattern: mounted only while open so state
// seeds from the row without reset effects. The field is empty by design —
// the server never returns the plaintext proxy URL, only a masked one
// (user:pass@ masked as user:***@), so there is nothing to re-display.
// Re-entering the same URL is a no-op; a partial edit is not possible,
// which is the correct trade-off for a credential-bearing field.
export function KeyProxyDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: ApiKey
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')

  const save = useMutation({
    mutationFn: (proxyUrl: string) =>
      apiFetch(`/api/keys/${apiKey.id}`, { method: 'PATCH', body: JSON.stringify({ proxyUrl }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      onOpenChange(false)
    },
  })

  const submit = () => save.mutate(draft.trim())

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md">
        <DialogTitle>{t('keys.keyProxy')}</DialogTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('keys.keyProxyDesc')}</p>
        <code className="mt-2 block truncate font-mono text-[11px] text-muted-foreground">{apiKey.maskedKey}</code>

        {apiKey.maskedProxyUrl ? (
          <div className="mt-3">
            <p className="text-[11px] font-medium text-muted-foreground">{t('keys.keyProxyCurrent')}</p>
            <code className="mt-1 block truncate rounded bg-muted/40 px-2 py-1 font-mono text-[11px]" title={apiKey.maskedProxyUrl}>
              {apiKey.maskedProxyUrl}
            </code>
          </div>
        ) : (
          <p className="mt-3 text-[11px] text-muted-foreground">{t('keys.keyProxyNone')}</p>
        )}

        <div className="mt-4 space-y-3">
          <Input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onOpenChange(false)
            }}
            placeholder="socks5://user:pass@127.0.0.1:1080"
            className="h-8 font-mono text-xs"
            disabled={save.isPending}
          />
          <p className="text-[11px] text-muted-foreground">{t('keys.keyProxyHint')}</p>

          {save.isError && (
            <p className="text-xs text-destructive">{(save.error as Error).message}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {apiKey.maskedProxyUrl && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mr-auto"
                onClick={() => save.mutate('')}
                disabled={save.isPending}
              >
                {t('keys.keyProxyClear')}
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={save.isPending || !draft.trim()}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
