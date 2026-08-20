import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'MM-Argus',
  tagline: 'The self-improving AI agent',
  favicon: 'img/favicon.ico',

  url: 'https://mmargus-team.github.io',
  baseUrl: '/Argus/docs/',

  organizationName: 'MMArgus-Team',
  projectName: 'Argus',

  onBrokenLinks: 'warn',

  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh-Hans'],
    localeConfigs: {
      en: {
        label: 'English',
      },
      'zh-Hans': {
        label: '简体中文',
        htmlLang: 'zh-Hans',
      },
    },
  },

  themes: [
    '@docusaurus/theme-mermaid',
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      /** @type {import("@easyops-cn/docusaurus-search-local").PluginOptions} */
      ({
        hashed: true,
        language: ['en', 'zh'],
        indexBlog: false,
        docsRouteBasePath: '/',
        // Disabled: appends ?_highlight=... to URLs (before the #anchor),
        // which makes copy/pasted doc links ugly. Ctrl+F on the page is fine.
        highlightSearchTermsOnTargetPage: false,
        // Exclude the auto-generated per-skill catalog pages from search.
        // There are hundreds of them and they dominate results for generic
        // terms, drowning out the real user-guide / reference docs.
        // The two human-written catalog indexes (reference/skills-catalog,
        // reference/optional-skills-catalog) remain indexed.
        //
        // Note: ignoreFiles matches `route` (baseUrl stripped, no leading
        // slash). With baseUrl '/Argus/docs/', `/Argus/docs/user-guide/skills/bundled/x`
        // becomes 'user-guide/skills/bundled/x'.
        ignoreFiles: [
          /^user-guide\/skills\/bundled\//,
          /^user-guide\/skills\/optional\//,
        ],
      }),
    ],
  ],

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        // Static-host redirects for renamed doc pages (GitHub Pages can't
        // do server-side redirects). Paths are relative to baseUrl (/Argus/docs/).
        redirects: [
          {
            // Renamed in #44470 (Automation Blueprints terminology rebrand)
            from: '/guides/automation-templates',
            to: '/guides/automation-blueprints',
          },
          {
            from: '/guides/run-hermes-with-nous-portal',
            to: '/guides/run-argus-with-nous-portal',
          },
          {
            from: '/guides/use-mcp-with-hermes',
            to: '/guides/use-mcp-with-argus',
          },
          {
            from: '/guides/use-soul-with-hermes',
            to: '/guides/use-soul-with-argus',
          },
          {
            from: '/guides/use-voice-mode-with-hermes',
            to: '/guides/use-voice-mode-with-argus',
          },
          {
            from: '/guides/build-a-hermes-plugin',
            to: '/guides/build-an-argus-plugin',
          },
        ],
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',  // Docs at the root of /Argus/docs/
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/MMArgus-Team/Argus/edit/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/mmargus-banner.png',
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: true,
      },
    },
    navbar: {
      title: 'MM-Argus',
      logo: {
        alt: 'MM-Argus',
        src: 'img/logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/skills',
          label: 'Skills',
          position: 'left',
        },
        {
          href: 'https://github.com/MMArgus-Team/Argus/releases',
          label: 'Download',
          position: 'left',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
        {
          href: 'https://github.com/MMArgus-Team/Argus',
          label: 'Home',
          position: 'right',
        },
        {
          href: 'https://github.com/MMArgus-Team/Argus',
          label: 'GitHub',
          position: 'right',
        },
        {
          href: 'https://github.com/MMArgus-Team/Argus/discussions',
          label: 'Discussions',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Getting Started', to: '/getting-started/quickstart' },
            { label: 'User Guide', to: '/user-guide/cli' },
            { label: 'Developer Guide', to: '/developer-guide/architecture' },
            { label: 'Reference', to: '/reference/cli-commands' },
          ],
        },
        {
          title: 'Community',
          items: [
            { label: 'Discussions', href: 'https://github.com/MMArgus-Team/Argus/discussions' },
            { label: 'GitHub Issues', href: 'https://github.com/MMArgus-Team/Argus/issues' },
            { label: 'Skills Hub', href: 'https://agentskills.io' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'Desktop Download', href: 'https://github.com/MMArgus-Team/Argus/releases' },
            { label: 'GitHub', href: 'https://github.com/MMArgus-Team/Argus' },
            { label: 'PyPI', href: 'https://pypi.org/project/mm-argus/' },
          ],
        },
      ],
      copyright: `Built by <a href="https://github.com/MMArgus-Team">MMArgus Team</a> · MIT License · ${new Date().getFullYear()}`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'yaml', 'json', 'python', 'toml'],
    },
    mermaid: {
      theme: {light: 'neutral', dark: 'dark'},
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
