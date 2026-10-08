import { useEffect, useId, useState } from 'react';
import type { CSSProperties } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../../lib/i18n';
import { useAuth } from '../../../lib/auth';
import { useTheme } from '../../../lib/theme';
import { errorText } from '../../../lib/errors';
import {
  APPEARANCE_NAME_MAX,
  checkAppearanceName,
  createAppearance,
  deleteAppearance,
  fetchAppearances,
  setListAppearance,
} from '../../../lib/appearances';
import type { Appearance } from '../../../lib/appearances';
import { DEFAULT_HUE, HUE_PRESETS, normalizeHue, overlayVars } from '../../../lib/hue-ramp.js';
import type { List } from '../../../lib/types';
import { FieldV2, NoteV2, SubmitV2 } from './AuthPartsV2';
import { SheetV2 } from './CommonV2';
import { ConfirmSheetV2 } from './ListPartsV2';
import { GuestCardV2 } from './GuestPartsV2';
import type { SharedItem } from '../../../lib/shares';

const noop = () => undefined;

/** Зразок картки гостя: та сама картка, що на гостьовій, з однією вигаданою позицією. */
const SAMPLE_ITEM = (title: string): SharedItem => ({
  id: 'sample',
  title,
  url: null,
  price: null,
  quantity: 1,
  priority: 'medium',
  note: null,
  variants: [],
  image_url: null,
  status: 'active',
  created_at: '1970-01-01T00:00:00Z',
  section_id: null,
  taken_qty: null,
  mine_qty: null,
});

const STROKE = 2.75;

/**
 * Кружечок відтінку — єдине місце, де колір показується як колір. Значення
 * рахує генератор із H (`lib/hue-ramp.js`), літералу в коді немає.
 */
function HueDotV2({ hue }: { hue: number | null }) {
  const { resolved } = useTheme();
  if (hue === null) return <span className="v2-hue v2-hue--none" aria-hidden="true" />;
  const vars = overlayVars(hue, resolved.theme);
  const color = resolved.theme === 'dark' ? vars['--color-accent-500'] : vars['--color-accent-700'];
  return <span className="v2-hue" style={{ background: color } as CSSProperties} aria-hidden="true" />;
}

/**
 * «Оформлення списку» v2 (ADR-034) — вигляд події, а не смак власника, тож
 * живе в самому списку. Перелік: «Без оформлення», вбудовані події, свої,
 * «Новий вигляд». Вибір застосовується одразу — це зворотна дія.
 *
 * «Новий вигляд» має один регулятор — відтінок — і живий приклад. Світлість
 * задає генератор, тож непридатне обрати неможливо. Висока контрастність
 * вимикає оформлення на екрані власника — і в прикладі теж.
 */
export function AppearanceSheetV2({
  open,
  list,
  onClose,
  onChanged,
  onPreview,
}: {
  open: boolean;
  list: List | null;
  onClose: () => void;
  onChanged: (appearanceId: string | null) => void;
  onPreview: () => void;
}) {
  const { t } = useI18n();
  const { session } = useAuth();
  const { resolved } = useTheme();
  const titleId = useId();
  const hueLabel = useId();

  const [items, setItems] = useState<Appearance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mode, setMode] = useState<'pick' | 'new'>('pick');
  const [toDelete, setToDelete] = useState<Appearance | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState('');
  const [hue, setHue] = useState<number>(DEFAULT_HUE);
  const [custom, setCustom] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const current = list?.appearance_id ?? null;
  const locked = resolved.locked === 'a11y';

  async function load() {
    try {
      setItems(await fetchAppearances());
      setError(null);
    } catch (e) {
      setError(errorText(e, t));
    }
  }

  useEffect(() => {
    if (!open) return;
    setMode('pick');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const label = (a: Appearance) => {
    switch (a.builtin_key) {
      case 'birthday':
        return t('appearance.builtin.birthday');
      case 'wedding':
        return t('appearance.builtin.wedding');
      case 'housewarming':
        return t('appearance.builtin.housewarming');
      default:
        return a.name;
    }
  };

  async function choose(id: string | null) {
    if (!list || busyId || id === current) return;
    setBusyId(id ?? 'none');
    setError(null);
    try {
      await setListAppearance(list.id, id);
      onChanged(id);
      await load();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusyId(null);
    }
  }

  function startNew() {
    setName('');
    setHue(DEFAULT_HUE);
    setCustom(false);
    setNameError(null);
    setMode('new');
  }

  async function saveNew() {
    if (saving || !list || !session) return;
    const problem = checkAppearanceName(name);
    if (problem) {
      setNameError(problem === 'emoji' ? t('appearance.nameEmoji') : t('appearance.nameEmpty'));
      return;
    }
    setSaving(true);
    setNameError(null);
    try {
      const created = await createAppearance(session.user.id, name, hue);
      await setListAppearance(list.id, created.id);
      onChanged(created.id);
      await load();
      setMode('pick');
    } catch (e) {
      setNameError(errorText(e, t));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete || deleting) return;
    setDeleting(true);
    try {
      await deleteAppearance(toDelete.id);
      if (toDelete.id === current) onChanged(null);
      setToDelete(null);
      await load();
    } catch (e) {
      setError(errorText(e, t));
      setToDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  const builtin = (items ?? []).filter((a) => a.builtin_key);
  const mine = (items ?? []).filter((a) => !a.builtin_key);

  function row(a: Appearance | null) {
    const id = a?.id ?? null;
    const on = current === id;
    return (
      <label className="v2-look" data-on={on || undefined}>
        <input
          type="radio"
          name="v2-appearance"
          checked={on}
          disabled={Boolean(busyId)}
          onChange={() => void choose(id)}
        />
        <HueDotV2 hue={a ? a.hue : null} />
        <span className="v2-look__text">
          <span className="v2-look__name">{a ? label(a) : t('appearance.none')}</span>
          {!a && <span className="v2-look__hint">{t('appearance.noneHint')}</span>}
          {a && !a.builtin_key && a.list_count > 0 && (
            <span className="v2-look__hint">{t('appearance.inLists', { n: a.list_count })}</span>
          )}
        </span>
        {busyId === (id ?? 'none') ? (
          <span className="v2-spinner" aria-hidden="true" />
        ) : (
          on && <Check size={20} strokeWidth={STROKE} aria-hidden="true" />
        )}
      </label>
    );
  }

  const problem = name ? checkAppearanceName(name) : null;
  const sample = locked ? undefined : (overlayVars(hue, resolved.theme) as CSSProperties);

  return (
    <>
      <SheetV2 open={open} onClose={onClose} labelledBy={titleId} className="v2-sheet--full" closeOnBackdrop={mode === 'pick'}>
        <div className="v2-bar">
          <button
            type="button"
            className="v2-bar__btn"
            onClick={mode === 'new' ? () => setMode('pick') : onClose}
          >
            {mode === 'new' ? t('appearance.back') : t('common.close')}
          </button>
          <h2 className="v2-bar__title" id={titleId}>
            {mode === 'new' ? t('appearance.new') : t('appearance.title')}
          </h2>
          <span className="v2-bar__spacer" aria-hidden="true" />
        </div>

        {mode === 'pick' ? (
          <div className="v2-itemsheet__body">
            {error && <NoteV2 tone="error">{error}</NoteV2>}
            {locked && <p className="v2-hint v2-hint--start">{t('appearance.a11yLocked')}</p>}
            <fieldset className="v2-looks">
              <legend className="v2-sr">{t('appearance.title')}</legend>
              {row(null)}
              {builtin.map((a) => (
                <div key={a.id}>{row(a)}</div>
              ))}
            </fieldset>
            {mine.length > 0 && (
              <fieldset className="v2-looks">
                <legend className="v2-kicker">{t('appearance.mine')}</legend>
                {mine.map((a) => (
                  <div key={a.id} className="v2-looks__own">
                    {row(a)}
                    <button
                      type="button"
                      className="v2-iconbtn"
                      aria-label={t('appearance.delete', { name: a.name })}
                      onClick={() => setToDelete(a)}
                    >
                      <Trash2 size={20} strokeWidth={STROKE} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </fieldset>
            )}
            <button type="button" className="v2-btn v2-btn--outline v2-btn--block" onClick={startNew}>
              <Plus size={20} strokeWidth={STROKE} aria-hidden="true" />
              {t('appearance.new')}
            </button>
            <div className="v2-card">
              <p className="v2-card__title">{t('appearance.guestsSee')}</p>
              <p className="v2-hint v2-hint--start">{t('appearance.guestsSeeBody')}</p>
            </div>
            <button type="button" className="v2-btn v2-btn--primary v2-btn--block" onClick={onPreview}>
              {t('appearance.preview')}
            </button>
          </div>
        ) : (
          <form
            className="v2-itemsheet__body"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void saveNew();
            }}
          >
            <FieldV2
              label={t('appearance.name')}
              name="appearance_name"
              maxLength={APPEARANCE_NAME_MAX}
              autoComplete="off"
              value={name}
              error={nameError ?? (problem === 'emoji' ? t('appearance.nameEmoji') : null)}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              after={<p className="v2-hint v2-hint--start">{t('appearance.namePrivate')}</p>}
            />

            <div className="v2-field">
              <p className="v2-field__label" id={hueLabel}>
                {t('appearance.hue')} · {t('appearance.hueHint')}
              </p>
              <div className="v2-swatches" role="radiogroup" aria-labelledby={hueLabel}>
                {HUE_PRESETS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    role="radio"
                    aria-checked={!custom && hue === h}
                    aria-label={t('appearance.hueSwatch', { h })}
                    className="v2-swatch"
                    style={overlayVars(h, resolved.theme) as CSSProperties}
                    onClick={() => {
                      setCustom(false);
                      setHue(h);
                    }}
                  />
                ))}
                <button
                  type="button"
                  role="radio"
                  aria-checked={custom}
                  aria-label={t('appearance.customHue')}
                  className="v2-swatch v2-swatch--custom"
                  onClick={() => setCustom(true)}
                >
                  <Plus size={18} strokeWidth={STROKE} aria-hidden="true" />
                </button>
              </div>
              {custom && (
                <label className="v2-slider">
                  <span className="v2-field__label">{t('appearance.customHue')}</span>
                  <input
                    type="range"
                    min={0}
                    max={359}
                    step={1}
                    value={hue}
                    onChange={(e) => setHue(normalizeHue(Number(e.target.value)))}
                  />
                  <span className="v2-hint">{hue}°</span>
                </label>
              )}
            </div>

            <div className="v2-field">
              <p className="v2-field__label">{t('appearance.example')}</p>
              {/* Шматок гостьової в цьому відтінку поверх твоєї схеми. */}
              <div className="v2-guest v2-guest--preview v2-guest--sample" style={sample}>
                <header className="v2-guest__head">
                  <p className="v2-guest__title">{list?.title}</p>
                </header>
                <div className="v2-guest__body">
                  <ul className="v2-gcards">
                    <GuestCardV2
                      item={SAMPLE_ITEM(t('appearance.sampleItem'))}
                      currency="PLN"
                      counts={{ left: 1, mine: 0 }}
                      canClaim
                      flag={null}
                      preview
                      onTake={noop}
                      onRelease={noop}
                      onKeep={noop}
                      onBought={noop}
                      onShop={noop}
                    />
                  </ul>
                </div>
              </div>
            </div>

            <SubmitV2 busy={saving} label={t('appearance.save')} busyLabel={t('appearance.saving')} />
          </form>
        )}
      </SheetV2>

      <ConfirmSheetV2
        open={toDelete !== null}
        id="v2-appearance-delete-title"
        title={t('appearance.confirmDeleteTitle', { name: toDelete?.name ?? '' })}
        body={t('appearance.confirmDeleteBody')}
        confirmLabel={t('appearance.confirmDelete')}
        busyLabel={t('appearance.deleting')}
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}
