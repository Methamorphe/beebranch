import { useEffect, useState } from 'react'
import {
  getGraphDateFormat,
  onGraphDateFormatChanged,
  type GraphDateFormat,
} from './graphDate'

/** History date format. Subscribes the component when the user changes it. */
export function useGraphDateFormat(): GraphDateFormat {
  const [format, setFormat] = useState(getGraphDateFormat)
  useEffect(() => onGraphDateFormatChanged(setFormat), [])
  return format
}
