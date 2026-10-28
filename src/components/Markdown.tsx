import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openExternalUrl } from '../ipc/commands'
import styles from './Markdown.module.css'

type Props = {
  /** Raw Markdown source. Rendered as React elements, never as HTML. */
  source: string
  className?: string
}

/**
 * Repository and release prose is untrusted, so this renderer never injects
 * HTML: `react-markdown` builds React elements and ignores raw HTML tags.
 * Images stay blocked (no remote request, no IP leak) and links only open
 * `https` URLs in the system browser — the webview itself never navigates.
 */
const components: Components = {
  a({ node: _node, href, children, ...rest }) {
    const external = typeof href === 'string' && /^https:\/\//i.test(href)
    if (!external) {
      return (
        <span className={styles.inactiveLink} title="Lien relatif : non ouvrable depuis l’application">
          {children}
        </span>
      )
    }
    return (
      <a
        {...rest}
        href={href}
        className={styles.link}
        title={href}
        rel="noreferrer noopener"
        onClick={(event) => {
          event.preventDefault()
          void openExternalUrl(href).catch(() => undefined)
        }}
      >
        {children}
      </a>
    )
  },
  img({ alt, src }) {
    return (
      <span className={styles.blockedImage} role="note">
        Image bloquée{alt ? ` · ${alt}` : ''}
        {typeof src === 'string' ? ` (${src})` : ''}
      </span>
    )
  },
}

export function Markdown({ source, className }: Props) {
  return (
    <div className={`${styles.root} ${className ?? ''}`} data-markdown="rendered">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  )
}
