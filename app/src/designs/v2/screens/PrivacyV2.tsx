import { Fragment } from 'react';
import { useI18n } from '../../../lib/i18n';
import { AuthFrameV2, BackHeaderV2 } from './AuthPartsV2';

/** Розділи політики в порядку показу; тексти — `privacy.s.<id>` у словниках. */
const SECTIONS = ['owner', 'guests', 'use', 'google', 'processors', 'device', 'keep', 'rights', 'changes'] as const;

/** Контакт для запитів щодо даних — з оточення збірки (Vercel), не з коду. */
const CONTACT = import.meta.env.VITE_CONTACT_EMAIL?.trim() || null;

/**
 * Тіло розділу: абзаци через порожній рядок, рядки з «• » — список. Так текст
 * лишається звичайним рядком у словнику й перекладається як є.
 */
function Body({ text }: { text: string }) {
  return (
    <>
      {text.split('\n\n').map((block, i) => {
        const lines = block.split('\n');
        return lines.every((l) => l.startsWith('• ')) ? (
          <ul key={i} className="v2-prose__list">
            {lines.map((l, j) => (
              <li key={j}>{l.slice(2)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{block}</p>
        );
      })}
    </>
  );
}

/**
 * Політика конфіденційності (`/privacy`) — публічна, без входу: на неї
 * посилається екран згоди Google (DEPLOY.md, 4.1), вхід, реєстрація й
 * гостьова. Описує те, що застосунок справді робить; змінилась поведінка з
 * даними — змінюється й ця сторінка разом із датою чинності.
 */
export default function PrivacyV2() {
  const { t } = useI18n();
  return (
    <AuthFrameV2 wide>
      <BackHeaderV2 to="/" title={t('privacy.title')} />
      <article className="v2-prose">
        <p className="v2-prose__meta">{t('privacy.updated')}</p>
        <p>{t('privacy.intro')}</p>
        {CONTACT && (
          <p>
            {t('privacy.contact', { email: '\uE000' })
              .split('\uE000')
              .map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && <a href={`mailto:${CONTACT}`}>{CONTACT}</a>}
                  {part}
                </Fragment>
              ))}
          </p>
        )}
        {SECTIONS.map((id) => (
          <section key={id} aria-labelledby={`privacy-${id}`}>
            <h2 id={`privacy-${id}`}>{t(`privacy.s.${id}.title`)}</h2>
            <Body text={t(`privacy.s.${id}.body`)} />
          </section>
        ))}
      </article>
    </AuthFrameV2>
  );
}
