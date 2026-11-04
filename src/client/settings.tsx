/**
 * 设置 screen: the target the tools and discovery read (PRD §5.10).
 *
 * Settings are ledger events, not a config file: saving appends a `profile/set` event through the
 * host and the YAML stays the bootstrap layer below it. Saving is a POST, so the values are
 * persisted before the UI says "saved". The salary floor shares its unit with the rest of the
 * plugin: yuan per month, never K.
 *
 * @module dsh-job-ledger/client/settings
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { SettingsView } from '../api/contract.ts'
import { postApi } from './api.ts'
import type { MessageKey } from './locales.ts'

/** Mirrors the host's bounds; the host still validates, this only keeps the UI honest. */
const MAX_TERMS = 10
const MAX_TERM_CHARS = 30

/** One tag-list field: chips, an inline input, Enter/comma to add, Backspace to remove the last. */
function TagField({
  label,
  help,
  placeholder,
  values,
  removeLabel,
  onChange,
}: {
  readonly label: string
  readonly help: string
  readonly placeholder: string
  readonly values: readonly string[]
  readonly removeLabel: string
  readonly onChange: (next: string[]) => void
}): ReactElement {
  const [draft, setDraft] = useState('')

  const commit = (): void => {
    const term = draft.trim()
    setDraft('')
    if (term === '' || term.length > MAX_TERM_CHARS) return
    if (values.length >= MAX_TERMS || values.includes(term)) return
    onChange([...values, term])
  }

  return (
    <div className="jl-field">
      <span className="jl-label">{label}</span>
      <div className="jl-tags">
        {values.map((value) => (
          <span key={value} className="jl-tag-item">
            {value}
            <button
              type="button"
              className="jl-tag-x"
              aria-label={`${removeLabel} ${value}`}
              onClick={() => {
                onChange(values.filter((entry) => entry !== value))
              }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="jl-tag-input"
          value={draft}
          placeholder={placeholder}
          maxLength={MAX_TERM_CHARS}
          onChange={(event) => {
            setDraft(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Backspace' && draft === '' && values.length > 0) {
              onChange(values.slice(0, -1))
            }
          }}
          onBlur={commit}
        />
      </div>
      <span className="jl-help">{help}</span>
    </div>
  )
}

/**
 * @param props current settings, translator, and the save callback
 * @returns the settings tab
 */
export function Settings({
  view,
  t,
  onSaved,
}: {
  readonly view: SettingsView | undefined
  readonly t: (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string
  readonly onSaved: (next: SettingsView) => void
}): ReactElement {
  const [roles, setRoles] = useState<string[]>([])
  const [cities, setCities] = useState<string[]>([])
  const [salary, setSalary] = useState('0')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (view === undefined) return
    setRoles([...view.target.roles])
    setCities([...view.target.cities])
    setSalary(String(view.target.salaryMin))
  }, [view])

  const touch = (): void => {
    setSaved(false)
    setError(undefined)
  }

  const save = async (): Promise<void> => {
    const salaryMin = Number(salary === '' ? '0' : salary)
    const salaryMax = view?.limits.salaryMinMax
    if (salaryMax === undefined || !Number.isInteger(salaryMin) || salaryMin < 0 || salaryMin > salaryMax) {
      setError(t('salaryFloorInvalid', { max: salaryMax ?? 0 }))
      return
    }
    setBusy(true)
    setError(undefined)
    const result = await postApi<SettingsView>('profile', { roles, cities, salaryMin })
    setBusy(false)
    if (result.ok) {
      onSaved(result.value)
      setSaved(true)
    } else {
      setError(result.failure.error)
    }
  }

  return (
    <div className="jl-card">
      <div className="jl-card-head">
        <h2 className="jl-card-title">{t('settings')}</h2>
        <span className="jl-note">
          {t('limits')}：{view === undefined ? '—' : `${String(view.limits.runSize)} / ${String(view.limits.daily)}`}
        </span>
      </div>

      <div className="jl-form">
        <p className="jl-note" style={{ margin: 0 }}>
          {t('settingsIntro')}
        </p>

        <TagField
          label={t('targetRoles')}
          help={t('targetRolesHint')}
          placeholder={t('addTerm')}
          removeLabel={t('remove')}
          values={roles}
          onChange={(next) => {
            touch()
            setRoles(next)
          }}
        />

        <TagField
          label={t('targetCities')}
          help={t('targetCitiesHint')}
          placeholder={t('addTerm')}
          removeLabel={t('remove')}
          values={cities}
          onChange={(next) => {
            touch()
            setCities(next)
          }}
        />

        <div className="jl-field">
          <label className="jl-label" htmlFor="jl-salary">
            {t('salaryFloor')}
          </label>
          <input
            id="jl-salary"
            className="jl-input"
            type="number"
            min={0}
            max={view?.limits.salaryMinMax}
            value={salary}
            onChange={(event) => {
              touch()
              setSalary(event.target.value)
            }}
          />
          <span className="jl-help">{t('salaryFloorHint')}</span>
        </div>

        <div className="jl-form-foot">
          <button
            type="button"
            className="jl-btn is-primary"
            disabled={busy || view === undefined}
            onClick={() => void save()}
          >
            {busy ? t('saving') : t('save')}
          </button>
          {saved ? <span className="jl-saved">{t('saved')}</span> : null}
          {error === undefined ? null : <span className="jl-error">{error}</span>}
        </div>

        <p className="jl-note" style={{ margin: 0 }}>
          {t('limitsHint')}
        </p>
      </div>
    </div>
  )
}
