import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useI18n } from '@/i18n'
import type { ApiKey } from '../../../../shared/types'
import { existingGroupLabels } from '@/lib/endpoint-groups'

// Free-text group for a custom endpoint (#1176), with the groups already in use
// offered as suggestions so a second endpoint joins "Work" instead of starting
// a "work" next to it. Blank = the default Custom group.
export function GroupLabelField({
  value,
  onChange,
  className,
  showHint = true,
}: {
  value: string
  onChange: (value: string) => void
  className?: string
  showHint?: boolean
}) {
  const { t } = useI18n()
  const id = useId()
  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })
  const suggestions = existingGroupLabels(keys)
  return (
    <div className="space-y-1.5">
      {/* First, so the hidden list never takes the spacing after the input. */}
      <datalist id={`${id}-suggestions`}>
        {suggestions.map(label => <option key={label} value={label} />)}
      </datalist>
      <Label className="text-xs" htmlFor={id}>{t('keys.groupLabel')}</Label>
      <Input
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={t('keys.groupLabelPlaceholder')}
        list={`${id}-suggestions`}
        maxLength={80}
        autoComplete="off"
        className={className}
      />
      {showHint && <p className="text-[11px] text-muted-foreground">{t('keys.groupLabelHint')}</p>}
    </div>
  )
}
