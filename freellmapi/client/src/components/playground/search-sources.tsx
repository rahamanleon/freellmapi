import { Globe } from 'lucide-react'
import { useI18n } from '@/i18n'
import { hostOf } from '@/lib/search'
import type { WebSearchMeta } from '@/lib/playground-conversations'

// The sources a web-searched answer was given (#1174), numbered to match the
// [n] citations the model was asked to use, with the engine that ran the
// search and how long it took.
export function SearchSources({ search }: { search: WebSearchMeta }) {
  const { t } = useI18n()
  return (
    <div className="mt-3 w-full rounded-xl border bg-muted/30 px-3 py-2 text-xs">
      <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
        <Globe className="size-3" />
        <span className="tabular-nums">
          {t('search.searched', { engine: search.engine, count: search.sources.length, latency: search.latency })}
        </span>
      </div>
      <ol className="space-y-0.5">
        {search.sources.map((source, i) => (
          <li key={`${i}-${source.url}`} className="flex min-w-0 gap-1.5">
            <span className="shrink-0 text-muted-foreground tabular-nums">[{i + 1}]</span>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 truncate underline underline-offset-2 hover:text-foreground"
              title={source.url}
            >
              {source.title || hostOf(source.url)}
            </a>
            <span className="shrink-0 text-muted-foreground">— {hostOf(source.url)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
