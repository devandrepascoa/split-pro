import { type SSRConfig } from 'next-i18next';

/**
 * Server-side translations without `fs`. next-i18next's `serverSideTranslations` reads
 * `public/locales` from disk, which does not exist on Workers. The locale JSON files are
 * bundled instead (one lazy chunk per file) and returned in the same `_nextI18Next` shape
 * that `appWithTranslation` expects.
 */
const localeFiles = import.meta.glob<{ default: Record<string, unknown> }>(
  '../../../public/locales/*/*.json',
);

const FALLBACK_LOCALE = 'en';

const loadNamespace = async (locale: string, ns: string) => {
  const loader = localeFiles[`../../../public/locales/${locale}/${ns}.json`];
  if (!loader) {
    return undefined;
  }
  return (await loader()).default;
};

export const customServerSideTranslations = async (
  locale: string | undefined,
  namespaces: string[],
): Promise<SSRConfig> => {
  const initialLocale = !locale || 'default' === locale ? FALLBACK_LOCALE : locale;
  const locales = [...new Set([initialLocale, FALLBACK_LOCALE])];

  const initialI18nStore: Record<string, Record<string, unknown>> = {};
  await Promise.all(
    locales.flatMap((lng) => {
      initialI18nStore[lng] = {};
      return namespaces.map(async (ns) => {
        const data = await loadNamespace(lng, ns);
        if (data) {
          initialI18nStore[lng]![ns] = data;
        }
      });
    }),
  );

  return {
    _nextI18Next: {
      initialI18nStore,
      initialLocale,
      ns: namespaces,
      // `appWithTranslation(MyApp, i18nConfig)` in _app.tsx supplies the config.
      userConfig: null,
    },
  };
};

export const withI18nStaticProps =
  (namespaces: string[] = ['common']) =>
  async ({ locale }: { locale: string }) => ({
    props: {
      ...(await customServerSideTranslations(locale, namespaces)),
    },
  });
