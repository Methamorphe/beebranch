import styles from './Brand.module.css'

export function Brand() {
  return (
    <div className={styles.brand}>
      <svg
        className={styles.mark}
        viewBox="0 0 24 24"
        role="img"
        aria-label="BeeBranch"
      >
        <path
          d="M12 2.2 20.5 7v10L12 21.8 3.5 17V7L12 2.2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
        <path
          d="M12 7.2v9.6M8.2 9.4v5.2M15.8 9.4v5.2"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <circle cx="12" cy="7" r="1.7" fill="currentColor" />
        <circle cx="8" cy="15" r="1.4" fill="currentColor" />
        <circle cx="16" cy="15" r="1.4" fill="currentColor" />
      </svg>
      <span>BeeBranch</span>
    </div>
  )
}
