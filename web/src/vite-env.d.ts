/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_MAP_STYLE_URL?: string;
  readonly VITE_MAP_STYLE_URL_DAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
