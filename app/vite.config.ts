import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Chequeo de host de Vite (protección anti DNS-rebinding, CVE-2025-24010).
// Lista EXPLÍCITA (no `true`, que desactiva el chequeo y reabre la vulnerabilidad):
// el punto inicial cubre el dominio y todos sus subdominios, así un solo config
// sirve para recepcion. / bio. / admin. etc. Aplica a dev Y preview (abajo).
// localhost e IPs están permitidos siempre por defecto en Vite.
const ALLOWED_HOSTS = ['.biowellness.ar', '.medplum.com.ar', 'localhost', '127.0.0.1'];

export default defineConfig(({ mode }) => {
  // Vite lee las variables de app/.env (este directorio), NO del .env de la raíz.
  // HMR_ se lee acá para la config del server; NO se expone al navegador (envPrefix).
  const env = {
    ...loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), ['MEDPLUM_', 'GOOGLE_', 'RECAPTCHA_', 'HMR_', 'VITE_']),
    ...process.env,
  };

  // Aviso visible en el build: sin GOOGLE_CLIENT_ID no aparece el botón de Google.
  if (env.GOOGLE_CLIENT_ID || env.VITE_GOOGLE_CLIENT_ID) {
    console.log(`  ✓ GOOGLE_CLIENT_ID detectado (login con Google habilitado): …${String(env.GOOGLE_CLIENT_ID || env.VITE_GOOGLE_CLIENT_ID).slice(-28)}`);
  } else {
    console.warn('  ⚠ GOOGLE_CLIENT_ID NO seteado: el botón "Acceder con Google" NO va a aparecer.');
    console.warn('    Definilo en app/.env (no en el .env de la raíz) y volvé a buildear.');
  }

  // HMR detrás de un proxy que termina TLS (nginx/Caddy/Traefik): el websocket de
  // hot-reload negocia su propia conexión, así que hay que decirle al cliente a qué
  // puerto/protocolo volver. Opt-in por app/.env para no romper el dev local directo:
  //   HMR_CLIENT_PORT=443   (puerto público del proxy)
  //   HMR_PROTOCOL=wss      (default wss si se setea el puerto)
  const hmrClientPort = Number(env.HMR_CLIENT_PORT ?? '') || undefined;
  const hmr = hmrClientPort
    ? { clientPort: hmrClientPort, protocol: (env.HMR_PROTOCOL as 'ws' | 'wss' | undefined) ?? 'wss' }
    : undefined;
  if (hmr) {
    console.log(`  ✓ HMR detrás de proxy: clientPort=${hmr.clientPort} protocol=${hmr.protocol}`);
  }

  return {
    plugins: [react()],

    // Exponemos al navegador SOLO variables con estos prefijos (convención Medplum:
    // MEDPLUM_BASE_URL, GOOGLE_CLIENT_ID, RECAPTCHA_SITE_KEY, etc.).
    // ⚠️ SEGURIDAD: nunca pongas secretos en app/.env. Con el prefijo MEDPLUM_, una
    // variable como MEDPLUM_CLIENT_SECRET quedaría embebida en el bundle del cliente.
    // Los secretos van solo en el .env de la raíz (seed/bots), que NO se carga acá.
    envPrefix: ['MEDPLUM_', 'GOOGLE_', 'RECAPTCHA_', 'VITE_'],

    // Alias `@bw` -> ../src para reutilizar la lógica pura del backend (semáforo,
    // tipos, catálogo). `fs.allow: ['..']` permite importar desde la raíz del repo.
    resolve: {
      alias: {
        '@bw': fileURLToPath(new URL('../src', import.meta.url)),
      },
    },

    server: {
      port: 5173,
      host: true, // escucha en 0.0.0.0 (acceso desde otra máquina / proxy)
      allowedHosts: ALLOWED_HOSTS,
      fs: { allow: ['..'] },
      ...(hmr ? { hmr } : {}),
    },

    preview: {
      port: 5173,
      host: true,
      allowedHosts: ALLOWED_HOSTS,
    },
  };
});
