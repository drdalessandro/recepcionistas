# Teleconsulta · Fase 0 — Jitsi Meet en una EC2 propia (runbook)

> **Estado: EN CURSO (2026-09-16).** Andrés dio el OK para avanzar con
> teleconsulta. Esta fase es **infraestructura, no toca el código del repo**:
> al terminar existe `meet.biowellness.ar` con salas cerradas por token, coturn
> funcionando y las tres pruebas de la semana cero pasadas. Visión completa y
> modelo: [`teleconsulta.md`](teleconsulta.md).
>
> **Lo que esta fase asume de §10:** solo el **dominio** (`meet.biowellness.ar`).
> Las otras ocho decisiones (cobro, honorarios, precios, aptitud virtual,
> no-show, acceso sin portal, Recepción y la sala, grilla) **no bloquean la
> infra** y se cierran una por una antes de la Fase 1. No se registran acá
> como tomadas hasta que se contesten.

---

## 0. Qué tiene que salir de esta fase (Definition of Done)

| # | Resultado | Cómo se verifica |
|---|---|---|
| 1 | `https://meet.biowellness.ar` responde con certificado válido | El navegador no avisa nada; `curl -sI` devuelve 200 |
| 2 | **Nadie entra sin token.** Con token, sí | Abrir una sala a mano → rechazada. Con token firmado → entra |
| 3 | El paciente espera al profesional, no al revés | Entrar primero con token de invitado → pantalla de espera. Entrar con token de moderador → arranca |
| 4 | Funciona desde redes restrictivas | Llamada desde 4G con Wi-Fi apagado, y desde una red corporativa si hay una a mano |
| 5 | El servidor relaya cuando hace falta | Llamada de **tres** personas (P2P se apaga a partir de la tercera) con video fluido |
| 6 | Funciona en iPhone dentro de una página embebida | Prueba con la página mínima de §7 |
| 7 | Sin grabación, sin servicios de terceros, sin página de bienvenida | Revisión del `config.js` de §5 |
| 8 | Operable por alguien que no lo instaló | §8: reinicios, logs, actualización, backup, dónde vive el secret |

## 1. Cómo instalar Jitsi: tres caminos

Jitsi Meet se puede instalar de tres maneras que sirven para producción. Las
tres dan el mismo producto; cambia quién lo opera y cómo se actualiza.

| | **A · Paquetes Debian (`apt`)** | **B · Docker (`docker-jitsi-meet`)** | **C · JaaS (Jitsi as a Service, 8x8)** |
|---|---|---|---|
| Qué es | El *quick install* oficial: `apt install jitsi-meet` instala web, Prosody, Jicofo, JVB **y coturn**, y configura nginx y el certificado | Contenedores oficiales orquestados con `docker compose` y un `.env` | Jitsi hosteado por 8x8: no hay servidor, se usa `8x8.vc` con tokens firmados con tu clave |
| Encaja con cómo operan hoy | **Sí**: la API de Medplum y el front de Recepción corren nativos con nginx y pm2 (`deploy/`). Es el mismo nginx, los mismos `systemctl`, el mismo `apt upgrade` | Suma Docker a una operación que hoy no lo usa. Quien tenga que arreglarlo a las 20 h necesita saber las dos cosas | No hay nada que operar |
| coturn | **Lo instala y configura el paquete**, incluido TURN sobre TLS multiplexado en 443, que es lo que salva las redes restrictivas | No viene: hay que sumar coturn aparte y cablearlo por variables | Incluido |
| JWT | `apt install jitsi-meet-tokens` y dos preguntas | `ENABLE_AUTH=1`, `AUTH_TYPE=jwt` en el `.env` | Obligatorio, RS256 con clave privada propia |
| Actualizar | `apt upgrade` (y `unattended-upgrades` para seguridad) | `docker compose pull && up -d` | Lo hacen ellos |
| Reproducir la instalación | Este runbook | El `.env` y el `compose` son la instalación | No aplica |
| Dónde viajan los datos | La EC2, en la región que elijamos | Ídem | Infraestructura de 8x8, fuera del país. `decisiones-pendientes.md` § Infra ya fijó **datos en Argentina** |
| Costo | La EC2 | La EC2 | Por usuario activo al mes, con capa gratuita chica |

**Recomendación: A, paquetes Debian.** Por tres motivos concretos, no por
gusto:

1. Es el camino que **menos cosas nuevas** mete en la operación existente.
2. **coturn sale configurado**, con el truco de TURN en 443. Con Docker eso es
   trabajo manual y es justamente la parte que más falla en producción.
3. Actualizar es `apt upgrade`, que ya corren en las otras EC2.

Docker queda como alternativa válida si en el futuro la EC2 se comparte con
otras cosas o si aparece la necesidad de replicar el servidor. JaaS se
descarta por el criterio de datos en Argentina, no por calidad.

El resto del runbook es el camino A. Al final (§9) hay el equivalente en
Docker por si se elige B.

## 2. AWS: la instancia

| Ítem | Valor | Por qué |
|---|---|---|
| Región | `sa-east-1` (São Paulo) | La más cercana a Buenos Aires y la que ya usan (SES). Para video, la latencia manda |
| Imagen | Ubuntu Server 24.04 LTS | Soportada por Jitsi; misma familia que las EC2 actuales |
| Tamaño inicial | `t3.medium` (2 vCPU, 4 GB) | Con tres especialidades hay pocas llamadas a la vez, y las de **dos personas van punto a punto**: el servidor casi no interviene. Se sube si hace falta, sin reinstalar |
| Disco | 20 GB gp3 | No se graba nada. Solo sistema y logs |
| IP | **Elastic IP** | La IP no puede cambiar: está en el DNS y en la config del JVB |
| DNS | Registro `A` `meet.biowellness.ar` → la Elastic IP | Antes de instalar: el certificado se pide contra el nombre |

**Security group** (entrada):

| Puerto | Protocolo | Para qué | Origen |
|---|---|---|---|
| 22 | TCP | SSH | **Solo la IP de quien administra** |
| 80 | TCP | Let's Encrypt y redirección a HTTPS | Cualquiera |
| 443 | TCP | Web de Jitsi **y** TURN sobre TLS (multiplexado) | Cualquiera |
| 10000 | UDP | Media del JVB | Cualquiera |
| 3478 | UDP y TCP | STUN/TURN | Cualquiera |
| 5349 | TCP | TURN sobre TLS (directo) | Cualquiera |

Salida: todo abierto (default). No hace falta IPv6 para el piloto.

## 3. Instalación (camino A)

Todo como `root` o con `sudo`, en la EC2 recién creada y **con el DNS ya
apuntando**.

```bash
# 1) Nombre de host: Jitsi lo usa para todo (config, certificado, Prosody).
hostnamectl set-hostname meet.biowellness.ar
echo "127.0.0.1 meet.biowellness.ar" >> /etc/hosts

# 2) Sistema al día.
apt update && apt upgrade -y
apt install -y apt-transport-https gnupg2 curl lsb-release

# 3) Repositorio de Prosody (versión más nueva que la de Ubuntu; lo pide Jitsi).
curl -sL https://prosody.im/files/prosody-debian-packages.key \
  -o /etc/apt/keyrings/prosody-debian-packages.key
echo "deb [signed-by=/etc/apt/keyrings/prosody-debian-packages.key] http://packages.prosody.im/debian $(lsb_release -sc) main" \
  > /etc/apt/sources.list.d/prosody-debian-packages.list
apt install -y lua5.2

# 4) Repositorio de Jitsi.
curl -sL https://download.jitsi.org/jitsi-key.gpg.key | gpg --dearmor > /usr/share/keyrings/jitsi-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/jitsi-keyring.gpg] https://download.jitsi.org stable/" \
  > /etc/apt/sources.list.d/jitsi-stable.list
apt update

# 5) Jitsi Meet. Pregunta el hostname (meet.biowellness.ar) y el certificado:
#    elegir "Let's Encrypt" si lo ofrece; si no, "self-signed" y el paso 6.
apt install -y jitsi-meet

# 6) Certificado real (si el paso 5 no lo hizo). Pide un email para los avisos.
/usr/share/jitsi-meet/scripts/install-letsencrypt-cert.sh
```

**Verificar** antes de seguir:

```bash
systemctl status prosody jicofo jitsi-videobridge2 nginx coturn --no-pager
curl -sI https://meet.biowellness.ar | head -1        # HTTP/2 200
ss -tulnp | grep -E ':443|:10000|:3478|:5349'         # los cuatro escuchando
```

En este punto **cualquiera puede crear salas**: es lo que cierra §4. No dejar
el servidor así más que el rato de la instalación.

### El JVB detrás de NAT

En EC2 la instancia tiene IP privada y la Elastic IP es NAT 1:1. El JVB tiene
que **anunciar la IP pública** o los clientes no lo alcanzan. Las versiones
actuales la detectan solas con la metadata de AWS; si la instancia exige
IMDSv2 la detección puede fallar. El síntoma es la **prueba 5** (tres
personas, sin video). La solución es la asignación estática:

```
# /etc/jitsi/videobridge/sip-communicator.properties (agregar)
org.ice4j.ice.harvest.NAT_HARVESTER_LOCAL_ADDRESS=<IP privada de la EC2>
org.ice4j.ice.harvest.NAT_HARVESTER_PUBLIC_ADDRESS=<Elastic IP>
```

y `systemctl restart jitsi-videobridge2`. Conviene ponerlo de entrada y no
esperar al síntoma.

## 4. Token (JWT): nadie entra sin firma

```bash
apt install -y jitsi-meet-tokens
```

Pregunta dos cosas:

| Pregunta | Valor | Notas |
|---|---|---|
| Application ID | `biowellness-teleconsulta` | Es el `iss` del token. Fijo |
| Application secret | `openssl rand -hex 32` | **Se guarda en dos lugares y en ninguno más**: acá y, en la Fase 1, como Project Secret `JITSI_JWT_SECRET` en Medplum. Nunca en el repo ni en un chat |

Queda en `/etc/prosody/conf.avail/meet.biowellness.ar.cfg.lua`:

```lua
VirtualHost "meet.biowellness.ar"
    authentication = "token"
    app_id = "biowellness-teleconsulta"
    app_secret = "<el secret>"
    allow_empty_token = false
```

**Los dos lados llevan token**, paciente y profesional: no hay dominio de
invitados anónimos. Lo que los distingue es el rol dentro del token.

### El profesional es el moderador; el paciente espera

Por defecto Jitsi hace moderador al **primero que entra**. Para que sea el
profesional y no quien llegó antes:

1. Apagar el auto-owner en Jicofo:

   ```hocon
   # /etc/jitsi/jicofo/jicofo.conf
   jicofo {
     conference {
       enable-auto-owner = false
     }
   }
   ```

2. Instalar el módulo `token_affiliation` de la colección
   [jitsi-contrib/prosody-plugins](https://github.com/jitsi-contrib/prosody-plugins)
   en `/usr/share/jitsi-meet/prosody-plugins/` y sumarlo a `modules_enabled`
   del componente de conferencias (`conference.meet.biowellness.ar`) en el
   mismo `.cfg.lua`. Lee el claim `context.user.affiliation` del token:
   `"owner"` es moderador, `"member"` no.

3. Que quien no es moderador **espere** hasta que entre uno: el módulo
   `muc_wait_for_host` que viene con Jitsi, sumado al mismo componente.

⚠️ **Verificar en la prueba 3.** Estos módulos cambian entre versiones de
Jitsi. Si la pantalla de espera no aparece, la alternativa es el **lobby**
(`lobby_autostart`, misma colección): el paciente toca el timbre y el
profesional lo admite. Cumple lo mismo con un clic más.

`systemctl restart prosody jicofo` después de tocar cualquiera de los dos.

### Forma del token

```jsonc
{
  "iss": "biowellness-teleconsulta",   // el Application ID
  "aud": "jitsi",
  "sub": "meet.biowellness.ar",        // el dominio
  "room": "tc-3f2a…",                  // UNA sala, nunca "*"
  "nbf": 1758000000,                   // 15 min antes del turno
  "exp": 1758007200,                   // 60 min después del fin
  "context": {
    "user": {
      "name": "Ana",                   // nombre elegido de la ficha; sin DNI ni email
      "affiliation": "owner"           // SOLO el profesional; el paciente: "member"
    }
  }
}
```

En producción lo firma el bot `bw-teleconsulta-token` (Fase 1). Para las
pruebas de esta fase se firma a mano, en cualquier máquina con Node (no en el
servidor, y sin dejar el secret en el historial del shell):

```bash
JITSI_SECRET='<el secret>' node -e '
const c = require("node:crypto");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const [room, rol] = process.argv.slice(1);
const claims = {
  iss: "biowellness-teleconsulta", aud: "jitsi", sub: "meet.biowellness.ar",
  room, nbf: now - 60, exp: now + 2 * 3600,
  context: { user: { name: rol === "owner" ? "Dra. Prueba" : "Paciente Prueba", affiliation: rol } },
};
const head = b64({ alg: "HS256", typ: "JWT" });
const body = b64(claims);
const sig = c.createHmac("sha256", process.env.JITSI_SECRET).update(`${head}.${body}`).digest("base64url");
console.log(`https://meet.biowellness.ar/${room}?jwt=${head}.${body}.${sig}`);
' tc-prueba-001 owner
```

Cambiar `owner` por `member` para el link del paciente. Los dos links van a la
misma sala `tc-prueba-001`.

## 5. Endurecimiento

Todo en `/etc/jitsi/meet/meet.biowellness.ar-config.js`, salvo que se
indique otra cosa. Son claves del objeto `config`; si ya existen
comentadas, descomentar y ajustar.

```js
// Sin página de bienvenida: la raíz no ofrece crear salas.
enableWelcomePage: false,
// Sala de prueba de cámara y micrófono antes de entrar. Es lo que el paciente ve primero.
prejoinConfig: { enabled: true },
// No ofrecer la app nativa: todo en el navegador (el portal es PWA).
disableDeepLinking: true,
// Nada sale a terceros: sin avatares de Gravatar, sin analytics, sin integraciones.
disableThirdPartyRequests: true,
analytics: { disabled: true },
// Idioma.
defaultLanguage: 'es',
// Dos personas: punto a punto (el servidor no ve el media). Es el default; se deja explícito.
p2p: { enabled: true },
// Sin grabación ni streaming. Sin Jibri instalado ya no aparecen; se deja explícito.
fileRecordingsEnabled: false,
liveStreamingEnabled: false,
```

**Embebido en el portal y el Dashboard.** El iframe de Jitsi solo puede
cargarse desde nuestros dominios. En el `server` de nginx de Jitsi
(`/etc/nginx/sites-available/meet.biowellness.ar.conf`):

```nginx
add_header Content-Security-Policy "frame-ancestors 'self' https://app.biowellness.ar https://<dominio del dashboard>;" always;
```

Sin esto cualquier sitio podría embeber nuestro servidor. Falta **el dominio
del Dashboard**: pedirlo antes de cerrar la fase.

**Logs sin PHI.** Los nombres de sala son UUIDs. El nombre visible del
participante aparece en los logs de Prosody en nivel `debug`/`info`: dejar
Prosody en `warn` (`log = { warn = "/var/log/prosody/prosody.log" }`) y JVB y
Jicofo en `INFO` como vienen. Rotación: la trae `logrotate` por defecto.

**Sistema.**

```bash
apt install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades
# SSH solo con clave: PasswordAuthentication no en /etc/ssh/sshd_config
```

## 6. coturn

El paquete `jitsi-meet-turnserver` lo instaló y configuró en el paso 3: un
`coturn` escuchando en 3478 y 5349, y nginx multiplexando el **443** entre la
web y TURN sobre TLS (módulo `stream`, ver
`/etc/nginx/modules-enabled/60-jitsi-meet.conf`). Ese multiplexado es lo que
hace funcionar la llamada desde una red que solo deja salir por 443.

Verificar: `systemctl status coturn` y la prueba 4. Si desde 4G no conecta,
lo primero es el security group (3478 UDP suele faltar).

## 7. Pruebas de aceptación

| # | Prueba | Cómo | Resultado esperado |
|---|---|---|---|
| 1 | Sin token | Abrir `https://meet.biowellness.ar/tc-prueba-001` sin `?jwt=` | Rechazo. No entra |
| 2 | Con token | Dos personas, una con link `owner` y otra con `member` (§4) | Las dos entran; el `owner` ve controles de moderador |
| 3 | Espera al profesional | Entrar **primero** con el link `member` | Pantalla de espera. Al entrar el `owner`, arranca |
| 4 | Red restrictiva | Una de las dos personas desde un celular con **Wi-Fi apagado** (4G) | Video y audio fluidos en los dos sentidos |
| 5 | Relay por el servidor | **Tres** personas en la misma sala | Video fluido. Si falla y con dos andaba, es el NAT del JVB (§3) |
| 6 | iPhone embebido | La página mínima de abajo, abierta en Safari y **agregada a la pantalla de inicio** | Pide cámara y micrófono y entra. Si en pantalla de inicio no funciona, el portal abre Jitsi en pestaña nueva |
| 7 | Token vencido | Link firmado con `exp` en el pasado | Rechazo |
| 8 | Sala equivocada | Token de `tc-prueba-001` usado en `tc-prueba-002` | Rechazo |

Página mínima para la prueba 6 (un archivo HTML en cualquier hosting con
HTTPS, o servido desde la misma EC2 en `/usr/share/jitsi-meet/prueba.html`
mientras dure la prueba):

```html
<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://meet.biowellness.ar/external_api.js"></script>
<div id="sala" style="height:100vh"></div>
<script>
  new JitsiMeetExternalAPI('meet.biowellness.ar', {
    roomName: 'tc-prueba-001',
    jwt: '<token member>',
    parentNode: document.getElementById('sala'),
  });
</script>
```

Para el `frame-ancestors` de §5, mientras se prueba desde otro hosting hay
que sumar ese dominio; después se saca.

## 8. Operación

| Qué | Cómo |
|---|---|
| Reiniciar todo | `systemctl restart prosody jicofo jitsi-videobridge2 coturn nginx` |
| Ver qué pasa | `journalctl -u jicofo -u jitsi-videobridge2 -f` · `tail -f /var/log/prosody/prosody.log` |
| Actualizar | `apt update && apt upgrade` (Jitsi incluido). Leer el changelog si cambia la versión mayor |
| Certificado | Se renueva solo (`certbot` o el timer que dejó el script). Verificar en 60 días: `certbot certificates` |
| Backup | `/etc/jitsi`, `/etc/prosody`, `/etc/nginx`, `/etc/turnserver.conf`. **No hay datos**: sin esos cuatro directorios y este runbook, se reinstala en una hora |
| Monitoreo mínimo | Alarma de CloudWatch por CPU > 80 % sostenido y por instancia caída. Un chequeo externo de `https://meet.biowellness.ar` cada 5 min |
| Dónde vive el secret | `/etc/prosody/conf.avail/meet.biowellness.ar.cfg.lua` y el Project Secret de Medplum (Fase 1). Rotarlo = cambiar en los dos y `systemctl restart prosody` |
| Cambiar el tamaño de la EC2 | Parar, cambiar tipo, arrancar. La Elastic IP se conserva; nada más cambia |

## 9. Equivalente en Docker (camino B), por si se elige

Mismo servidor, mismo DNS, mismo security group. En lugar de §3 y §4:

```bash
apt install -y docker.io docker-compose-v2
git clone https://github.com/jitsi/docker-jitsi-meet && cd docker-jitsi-meet
cp env.example .env && ./gen-passwords.sh
mkdir -p ~/.jitsi-meet-cfg/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb}
```

En el `.env`:

```
PUBLIC_URL=https://meet.biowellness.ar
ENABLE_LETSENCRYPT=1
LETSENCRYPT_DOMAIN=meet.biowellness.ar
LETSENCRYPT_EMAIL=<email>
ENABLE_AUTH=1
AUTH_TYPE=jwt
JWT_APP_ID=biowellness-teleconsulta
JWT_APP_SECRET=<el secret>
ENABLE_GUESTS=0
JVB_ADVERTISE_IPS=<Elastic IP>
ENABLE_RECORDING=0
```

y `docker compose up -d`. Lo que en A viene resuelto y en B hay que hacer a
mano: **coturn** (contenedor aparte y variables `TURN_HOST`/`TURNS_HOST`), el
multiplexado de 443, y los módulos de Prosody de §4, que van en
`prosody-plugins-custom`.

## 10. Costo (orden de magnitud)

Componentes: la `t3.medium` on-demand en `sa-east-1`, la Elastic IP (AWS
cobra las IPv4 públicas), 20 GB gp3 y el tráfico de salida. Para llamadas de
dos personas el tráfico por el servidor es casi nulo (punto a punto); cuando
interviene TURN o hay tres o más personas, sí cuenta. Para el piloto, **del
orden de USD 50 a 70 por mes**: confirmar con la calculadora de AWS antes de
crear la instancia, y considerar una instancia reservada si el piloto sigue.

## 11. Lo que NO es de esta fase

Los cuatro bots, la página del portal, el botón del Dashboard, las policies y
el catálogo. Todo eso es la **Fase 1** y depende de que las ocho decisiones
restantes de `teleconsulta.md` §10 estén contestadas.

## 12. Checklist para cerrar la fase

- [ ] Instancia creada en `sa-east-1` con Elastic IP y security group de §2
- [ ] DNS `meet.biowellness.ar` apuntando y certificado válido
- [ ] `jitsi-meet` y `jitsi-meet-tokens` instalados; secret generado y guardado
- [ ] NAT del JVB configurado (§3)
- [ ] Moderador por token y espera del paciente funcionando (§4, prueba 3)
- [ ] `config.js` endurecido y `frame-ancestors` con los dos dominios (§5)
- [ ] Las ocho pruebas de §7 pasadas, con fecha y quién las hizo
- [ ] `unattended-upgrades` y SSH solo con clave
- [ ] Backup de los cuatro directorios de §8 hecho una vez
- [ ] Este runbook corregido con lo que se aprendió en la instalación real
