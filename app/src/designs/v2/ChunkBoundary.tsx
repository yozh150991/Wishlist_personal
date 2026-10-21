import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { WifiOff } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

/**
 * Запобіжник для лінивих чанків (ADR-067): екрани власника й гостьова
 * вантажаться окремо, і чанк може не приїхати — немає мережі, а Service
 * Worker його ще не має, або після деплою старого файлу вже немає. Без
 * запобіжника React знімає все дерево, і людина бачить порожню сторінку.
 *
 * Тут — пояснення на місці екрана й «Спробувати ще раз». Повтор
 * перезавантажує сторінку: `React.lazy` запамʼятовує невдачу, і без
 * перезавантаження той самий чанк не просився б удруге. Навігація
 * (`ShellV2`) лишається на місці — запобіжник стоїть лише навколо `Outlet`.
 */
export class ChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Без токенів і даних: лише текст помилки й місце в дереві (CLAUDE.md §3.5).
    console.error('[ChunkBoundary]', error.message, info.componentStack?.split('\n')[1]?.trim());
  }

  render() {
    return this.state.failed ? <ChunkFailed /> : this.props.children;
  }
}

function ChunkFailed() {
  const { t } = useI18n();
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  return (
    <main className="v2-page">
      <div className="v2-empty">
        <span className="v2-circle v2-circle--warm" aria-hidden="true">
          <WifiOff size={32} strokeWidth={2.75} />
        </span>
        <h1 className="v2-empty__title">{t('v2app.screenFailed.title')}</h1>
        <p className="v2-lede" role="alert">
          {offline ? t('errors.offline') : t('v2app.screenFailed.body')}
        </p>
        <button type="button" className="v2-btn v2-btn--primary" onClick={() => window.location.reload()}>
          {t('common.retry')}
        </button>
      </div>
    </main>
  );
}
