/**
 * KeyValueEditor — dynamic list of key-value pairs with add/remove.
 * Used for HTTP headers.
 */

import { useCallback } from 'react'
import { TextField, Input, Button, cn } from '@heroui/react'
import { Icon } from '@iconify/react'

export interface KeyValuePair {
  key: string
  value: string
}

interface KeyValueEditorProps {
  label?: string
  pairs: KeyValuePair[]
  onChange: (pairs: KeyValuePair[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  isDisabled?: boolean
}

export default function KeyValueEditor({
  label,
  pairs,
  onChange,
  keyPlaceholder = 'Header name',
  valuePlaceholder = 'Value',
  isDisabled,
}: KeyValueEditorProps) {
  const updatePair = useCallback(
    (index: number, field: 'key' | 'value', val: string) => {
      const next = [...pairs]
      next[index] = { ...next[index], [field]: val }
      onChange(next)
    },
    [pairs, onChange],
  )

  const removePair = useCallback(
    (index: number) => {
      onChange(pairs.filter((_, i) => i !== index))
    },
    [pairs, onChange],
  )

  const addPair = useCallback(() => {
    onChange([...pairs, { key: '', value: '' }])
  }, [pairs, onChange])

  return (
    <div className="flex flex-col gap-2">
      {label && <span className="text-xs font-medium text-wd-muted">{label}</span>}

      {pairs.map((pair, i) => (
        <div key={i} className="flex items-center gap-2">
          <TextField className="flex-1" isDisabled={isDisabled} aria-label={`Header key ${i + 1}`}>
            <Input
              placeholder={keyPlaceholder}
              value={pair.key}
              onChange={(e) => updatePair(i, 'key', e.target.value)}
              className="!text-xs"
            />
          </TextField>
          <TextField className="flex-1" isDisabled={isDisabled} aria-label={`Header value ${i + 1}`}>
            <Input
              placeholder={valuePlaceholder}
              value={pair.value}
              onChange={(e) => updatePair(i, 'value', e.target.value)}
              className="!text-xs"
            />
          </TextField>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            className="!min-w-7 !h-7 !rounded-lg shrink-0"
            isDisabled={isDisabled}
            onPress={() => removePair(i)}
          >
            <Icon icon="solar:trash-bin-minimalistic-outline" width={14} className="text-wd-danger" />
          </Button>
        </div>
      ))}

      <Button
        size="sm"
        variant="ghost"
        className="!text-xs !text-wd-primary self-start"
        isDisabled={isDisabled}
        onPress={addPair}
      >
        <Icon icon="solar:add-circle-outline" width={14} />
        Add header
      </Button>
    </div>
  )
}
