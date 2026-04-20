/**
 * ChipInput — text input that converts entries into removable chips/tags.
 * Used for things like expected status codes (type a number, press Enter, it becomes a chip).
 */

import { useState, useCallback } from 'react'
import { TextField, Input, cn } from '@heroui/react'
import { Icon } from '@iconify/react'

interface ChipInputProps {
  label: string
  description?: string
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
  /** Validate before adding — return error string or null */
  validate?: (value: string) => string | null
  isDisabled?: boolean
}

export default function ChipInput({
  label,
  description,
  values,
  onChange,
  placeholder = 'Type and press Enter',
  validate,
  isDisabled,
}: ChipInputProps) {
  const [inputValue, setInputValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const addValue = useCallback(() => {
    const trimmed = inputValue.trim()
    if (!trimmed) return

    if (validate) {
      const err = validate(trimmed)
      if (err) {
        setError(err)
        return
      }
    }

    if (values.includes(trimmed)) {
      setError('Already added')
      return
    }

    onChange([...values, trimmed])
    setInputValue('')
    setError(null)
  }, [inputValue, values, onChange, validate])

  const removeValue = useCallback(
    (val: string) => {
      onChange(values.filter((v) => v !== val))
    },
    [values, onChange],
  )

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-wd-muted">{label}</span>

      {/* Chips */}
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className={cn(
                'inline-flex items-center gap-1 rounded-md text-xs font-mono px-2 py-0.5',
                'bg-wd-primary/10 text-wd-primary border border-wd-primary/20',
              )}
            >
              {v}
              <button
                type="button"
                onClick={() => removeValue(v)}
                className="text-wd-primary/60 hover:text-wd-primary cursor-pointer"
                disabled={isDisabled}
              >
                <Icon icon="solar:close-circle-linear" width={16} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input */}
      <TextField
        isDisabled={isDisabled}
        isInvalid={!!error}
        aria-label={label}
      >
        <Input
          placeholder={placeholder}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addValue()
            }
          }}
          className="!text-xs !font-mono"
        />
      </TextField>
      {error && <span className="text-[11px] text-wd-danger">{error}</span>}
      {description && !error && (
        <span className="text-[11px] text-wd-muted/60">{description}</span>
      )}
    </div>
  )
}
