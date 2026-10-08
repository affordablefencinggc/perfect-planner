import config from './vite.config.mjs'; export default (env) => ({...config(env), cacheDir: '.local-preview-cache'});
