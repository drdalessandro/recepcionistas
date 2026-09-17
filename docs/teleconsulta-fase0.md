# Teleconsulta · Fase 0 — Jitsi Meet en una EC2 propia (runbook)

> **Estado: INSTALADO Y VERIFICADO EN PARTE (2026-09-16).** `meet.biowellness.ar`
> está en pie con certificado válido, **acceso solo por token** y el
> **profesional como único moderador**. Faltan cinco pruebas de aceptación (§7)
> y el dominio del Dashboard para cerrar §5. Visión y modelo:
> [`teleconsulta.md`](teleconsulta.md).
>
> Este documento se corrigió **después** de la instalación real, con lo que
> falló de verdad. Las trampas están en §13; valen más que el resto del texto.
>
> **Lo que esta fase asume de `teleconsulta.md` §10:** solo el **dominio**. Las
> otras ocho decisiones siguen abiertas y no se registran como tomadas.

---

## 0. Qué tiene que salir de esta fase (Definition of Done)

| # | Resultado | Estado |
|---|---|---|
| 1 | `https://meet.biowellness.ar` con certificado válido | ✅ verificado en navegador |
| 2 | Nadie entra sin token; con token firmado, sí | ✅ verificado |
| 3 | El profesional es moderador **por el token**, no por llegar primero | ✅ verificado (§4) |
| 4 | El paciente **no** puede silenciar ni expulsar al profesional | ✅ verificado en el panel de participantes |
| 5 | Funciona desde redes restrictivas (4G) | ⏳ pendiente |
| 6 | Tres personas con video fluido (relay por el servidor) | ⏳ pendiente |
| 7 | Funciona en iPhone dentro de una página embebida | ⏳ pendiente |
| 8 | Sin grabación, sin terceros, sin bienvenida, barra recortada | ✅ aplicado (§5) |
| 9 | `frame-ancestors` con los dominios del portal y del Dashboard | ⚠️ línea lista (§5) — **falta aplicarla en el servidor** |
| 10 | Operable por alguien que no lo instaló | ✅ §8 |

## 1. Cómo instalar Jitsi: tres caminos

| | **A · Paquetes Debian (`apt`)** | **B · Docker** | **C · JaaS (8x8)** |
|---|---|---|---|
| Qué es | El *quick install* oficial: instala web, Prosody, Jicofo, JVB **y coturn**, y configura nginx y el certificado | Contenedores oficiales con `docker compose` y un `.env` | Jitsi hosteado por 8x8, sin servidor |
| Encaja con la operación actual | **Sí**: la API de Medplum y el front de Recepción corren nativos con nginx y pm2 (`deploy/`) | Suma Docker a una operación que no lo usa | No hay nada que operar |
| coturn | **Lo instala y configura el paquete**, incluido TURN sobre TLS | Aparte, a mano | Incluido |
| JWT | `apt install jitsi-meet-tokens` | Variables del `.env` | Obligatorio |
| Datos | En nuestra EC2 | Ídem | Fuera del país — choca con `decisiones-pendientes.md` § Infra |

**Se eligió A**, y la instalación real confirmó los tres motivos: coturn quedó
configurado solo, los módulos de Prosody que hacían falta vinieron en el
paquete (§4), y todo el material de consulta está escrito sobre esta variante.
El equivalente en Docker queda en §9.

> **Sistema operativo: Ubuntu 24.04 LTS.** Es lo que Jitsi documenta y prueba.
> **Se intentó primero sobre 26.04 y se abandonó**: la instalación completó,
> pero la verificación del control de acceso quedó sin concluir y se decidió no
> seguir depurando sobre una versión fuera de lo soportado. No quedó demostrado
> que 26.04 no sirva; sí quedó claro que depurar ahí cuesta caro. Recrear la
> instancia sobre 24.04 son 30 minutos y la Elastic IP se reasigna, así que el
> DNS no se toca.

## 2. AWS: la instancia

| Ítem | Valor |
|---|---|
| Región | `sa-east-1` (São Paulo) — la más cercana; para video manda la latencia |
| Imagen | **Ubuntu Server 24.04 LTS** |
| Tamaño | `t3.medium` (2 vCPU, 3,7 GiB). Las llamadas de dos personas van punto a punto: el servidor casi no interviene |
| Disco | 20 GB gp3. No se graba nada |
| IP | **Elastic IP** — está en el DNS y en la config del JVB |
| DNS | `A` `meet.biowellness.ar` → la Elastic IP, **antes** de instalar |

**Security group** (entrada). La fila del 80 es la que se olvida y la que
rompe el certificado:

| Puerto | Protocolo | Para qué | Origen |
|---|---|---|---|
| 22 | TCP | SSH | **Solo la IP de quien administra** |
| **80** | **TCP** | **Validación de Let's Encrypt (ACME HTTP-01) y redirección** | **`0.0.0.0/0`** |
| 443 | TCP | Web de Jitsi y TURN sobre TLS | `0.0.0.0/0` |
| 10000 | UDP | Media del JVB | `0.0.0.0/0` |
| 3478 | UDP y TCP | STUN/TURN | `0.0.0.0/0` |
| 5349 | TCP | TURN sobre TLS | `0.0.0.0/0` |

> ⚠️ **El 80 va abierto a todo internet, no a tu IP.** Quien valida es Let's
> Encrypt desde sus servidores. Con el 80 cerrado el script falla con
> `Timeout during connect (likely firewall problem)` — pasó en la instalación
> real. `ufw` viene inactivo en la AMI de Ubuntu, así que el único filtro es el
> security group.

## 3. Instalación

Como `root` (`sudo -i`), con el DNS ya apuntando y el **puerto 80 abierto**.

### Paso 0 · Verificar antes de tocar nada

```bash
dig +short meet.biowellness.ar          # tiene que dar...
curl -s https://checkip.amazonaws.com   # ...lo mismo que esto
lsb_release -d && nproc && free -h | head -2
hostname -I | awk '{print $1}'          # IP privada: va en el NAT del JVB (§3.2)
ufw status
```

Si las dos primeras IPs no coinciden, no sigas: Let's Encrypt limita los
intentos fallidos por dominio.

### Paso 1 · Hostname

```bash
hostnamectl set-hostname meet.biowellness.ar
echo "127.0.0.1 meet.biowellness.ar" >> /etc/hosts
hostname -f    # debe devolver meet.biowellness.ar
```

### Paso 2 · Repositorios

```bash
apt update && apt upgrade -y
apt install -y apt-transport-https gnupg2 curl lsb-release

# El mkdir NO es opcional: /etc/apt/keyrings no existe en una Ubuntu recién
# instalada, y sin él el curl falla y el repositorio queda sin clave.
mkdir -p /etc/apt/keyrings
curl -sL https://prosody.im/files/prosody-debian-packages.key \
  -o /etc/apt/keyrings/prosody-debian-packages.key
echo "deb [signed-by=/etc/apt/keyrings/prosody-debian-packages.key] http://packages.prosody.im/debian $(lsb_release -sc) main" \
  > /etc/apt/sources.list.d/prosody-debian-packages.list
apt install -y lua5.2

curl -sL https://download.jitsi.org/jitsi-key.gpg.key | gpg --dearmor > /usr/share/keyrings/jitsi-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/jitsi-keyring.gpg] https://download.jitsi.org stable/" \
  > /etc/apt/sources.list.d/jitsi-stable.list
apt update
```

### Paso 3 · Jitsi y certificado

```bash
apt install -y jitsi-meet
```

Dos preguntas en pantalla azul: el **hostname** (`meet.biowellness.ar`, no
dejar el default) y el certificado (**"Generate a new self-signed
certificate"**; el real sale en el comando siguiente).

```bash
/usr/share/jitsi-meet/scripts/install-letsencrypt-cert.sh
```

Verificar:

```bash
systemctl status prosody jicofo jitsi-videobridge2 nginx coturn --no-pager | grep -E 'Loaded|Active'
curl -sI https://meet.biowellness.ar | head -1        # HTTP/2 200
ss -tulnp | grep -E ':80 |:443|:10000|:3478|:5349'
```

Los puertos escuchan en la **IP privada**, no en `0.0.0.0`: es correcto en EC2,
donde la Elastic IP se traduce a la privada antes de llegar a la placa. No lo
cambies. El **5349 aparece recién cuando hay certificado**: si falta, es que el
certificado no salió.

En este punto **cualquiera puede crear salas**. Lo cierra §4, y no conviene
dejarlo así más que el rato de la instalación.

### 3.2 · El JVB detrás de NAT

Poner de entrada, no esperar al síntoma (que es la prueba de tres personas sin
video). Agregar al final de
`/etc/jitsi/videobridge/sip-communicator.properties`, con las IPs reales:

```properties
org.ice4j.ice.harvest.NAT_HARVESTER_LOCAL_ADDRESS=<IP privada>
org.ice4j.ice.harvest.NAT_HARVESTER_PUBLIC_ADDRESS=<Elastic IP>
```

y `systemctl restart jitsi-videobridge2`.

## 4. Token y moderador

Esta sección es la que más cambió respecto del plan. **Leerla entera antes de
ejecutarla**: las piezas se pisan entre sí y el orden importa.

### 4.1 · Cerrar con token

```bash
openssl rand -hex 32     # guardar en el gestor de credenciales, NO en un chat
apt install -y jitsi-meet-tokens
```

| Pregunta | Valor |
|---|---|
| Application ID | `biowellness-teleconsulta` — es el `iss` del token, fijo |
| Application secret | El hexadecimal generado. Vive en **dos** lugares: este servidor y, en la Fase 1, el Project Secret `JITSI_JWT_SECRET` de Medplum |

Si el diálogo no aparece: `dpkg-reconfigure jitsi-meet-tokens`, o editar a mano
`/etc/prosody/conf.avail/meet.biowellness.ar.cfg.lua`. Falta **una línea que el
paquete no escribe** y que no hay que dejar librada al default de la versión:

```bash
cp /etc/prosody/conf.avail/meet.biowellness.ar.cfg.lua{,.bak}
sed -i '/^[[:space:]]*app_secret[[:space:]]*=/a\    allow_empty_token = false' \
  /etc/prosody/conf.avail/meet.biowellness.ar.cfg.lua
```

El bloque del host principal queda:

```lua
VirtualHost "meet.biowellness.ar"
    authentication = "token"
    app_id = "biowellness-teleconsulta"
    app_secret = "<el secret>"
    allow_empty_token = false
```

Los `authentication = "internal_hashed"` de `auth.` y `recorder.` son los hosts
internos: **no se tocan**. Si existiera un `VirtualHost "guest.…"`, ese sí se
comenta: es la puerta anónima.

### 4.2 · El profesional es el único moderador

Tres cambios, y **los tres son necesarios**. Con dos de tres, el paciente queda
de moderador y no se nota hasta que alguien mira el panel de participantes.

**a) Jicofo: que no premie al que llega primero.** La clave está confirmada
contra la configuración de referencia de la versión instalada
(`unzip -p /usr/share/jicofo/jicofo.jar reference.conf | grep -B4 -A4 auto-owner`):

```bash
cp /etc/jitsi/jicofo/jicofo.conf{,.bak}
sed -i '/^jicofo {/a\  conference: {\n    enable-auto-owner = false\n  }' /etc/jitsi/jicofo/jicofo.conf
```

**b) Prosody: los dos módulos, que ya vienen en el paquete.** No hay que bajar
nada de la colección de la comunidad:

```bash
cp /etc/prosody/conf.avail/meet.biowellness.ar.cfg.lua{,.bak-mod}
sed -i '/^Component "conference\.meet\.biowellness\.ar"/,/^Component "breakout/ s/^\([[:space:]]*\)"token_verification";/\1"token_verification";\n\1"token_affiliation";\n\1"muc_wait_for_host";/' \
  /etc/prosody/conf.avail/meet.biowellness.ar.cfg.lua
```

El rango acotado entre los dos `Component` evita tocar el de *breakout*, que
tiene una lista parecida.

**c) La línea sin la cual nada de lo anterior sirve.** `mod_muc_wait_for_host`
trae un comportamiento por defecto que **promueve a dueño a todo el que llegue
con un token**, en el evento `joined`, o sea *después* de que
`token_affiliation` puso `member` en el `pre-join`. Le pisa el trabajo:

```lua
-- /usr/share/jitsi-meet/prosody-plugins/mod_muc_wait_for_host.lua
if not disable_auto_owners then
    module:hook('muc-occupant-joined', function (event)
        if not is_moderated_room and (session.auth_token or ...) then
            room:set_affiliation(true, occupant.bare_jid, 'owner');
```

Se apaga con:

```bash
sed -i '/^Component "conference\.meet\.biowellness\.ar"/a\    wait_for_host_disable_auto_owners = true' \
  /etc/prosody/conf.avail/meet.biowellness.ar.cfg.lua

systemctl restart prosody jicofo
systemctl is-active prosody jicofo
```

### 4.3 · Forma del token

Confirmada leyendo `mod_token_affiliation.lua`, que acepta `owner`, `moderator`
o `teacher` en `context.user.affiliation` (o `context.user.moderator = true`);
cualquier otra cosa da `member`.

```jsonc
{
  "iss": "biowellness-teleconsulta",
  "aud": "jitsi",
  "sub": "meet.biowellness.ar",
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

Generador de prueba, sin dejar el secreto en el historial del shell:

```bash
read -rsp 'Secret: ' JITSI_SECRET; echo
export JITSI_SECRET
for rol in member owner; do
node -e '
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
const sig = c.createHmac("sha256", process.env.JITSI_SECRET).update(head + "." + body).digest("base64url");
console.log(rol.toUpperCase() + ": https://meet.biowellness.ar/" + room + "?jwt=" + head + "." + body + "." + sig);
' prueba $rol
done
unset JITSI_SECRET
```

### 4.4 · La sala de espera va en el portal, no en Jitsi

**Decisión tomada durante la instalación (2026-09-16).**
`mod_muc_wait_for_host` define anfitrión así, en su propia cabecera:

> A "host" is any session with a JWT auth_token

Está pensado para instalaciones donde el profesional tiene token y los
invitados entran sin nada. **En nuestro diseño los dos llevan token**, así que
el paciente cuenta como anfitrión y el módulo nunca lo retiene. No es un error
de configuración: la herramienta distingue "con token" de "sin token", y
nosotros necesitamos distinguir "dueño" de "miembro".

En vez de armar el lobby con piezas adicionales, **la espera se resuelve en el
portal** (Fase 1):

- El botón de entrar aparece recién 15 minutos antes del turno.
- Mientras el profesional no se conectó, el portal muestra su propio mensaje
  alrededor del video, en castellano y con contexto clínico, en lugar de la
  pantalla genérica de Jitsi.
- Recepción se entera igual de que el paciente está en línea: lo dispara
  `bw-teleconsulta-presencia`, no Jitsi.

El riesgo de que el paciente entre antes es nulo: a esa sala **solo él y su
profesional tienen token**.

`muc_wait_for_host` se deja cargado igual —es inocuo con
`wait_for_host_disable_auto_owners = true`— por si más adelante se suma un
tercer participante sin token.

## 5. Endurecimiento

Se aplica **al final** del `config.js`, después del objeto, en vez de editar
adentro del literal: así cada opción queda explícita y auditable, y se ve de un
vistazo qué tocamos nosotros.

```bash
cp /etc/jitsi/meet/meet.biowellness.ar-config.js{,.bak}
```

Y al final de `/etc/jitsi/meet/meet.biowellness.ar-config.js`:

```js
// ── Biowellness · endurecimiento de teleconsulta (Fase 0) ──────────────
config.enableWelcomePage = false;          // la raíz no ofrece crear salas
config.prejoinConfig = { enabled: true };  // probar cámara y micrófono antes de entrar
config.disableDeepLinking = true;          // todo en el navegador; el portal es PWA
config.disableThirdPartyRequests = true;   // sin avatares externos ni pedidos a terceros
config.analytics = { disabled: true };
config.defaultLanguage = 'es';
config.disableProfile = true;              // el nombre lo fija el token
config.fileRecordingsEnabled = false;      // sin grabación
config.liveStreamingEnabled = false;       // sin transmisión
config.hideConferenceSubject = true;
config.toolbarButtons = [
  'microphone', 'camera', 'desktop', 'chat', 'raisehand',
  'participants-pane', 'tileview', 'videoquality', 'settings',
  'fullscreen', 'hangup'
];
```

No hace falta reiniciar: lo sirve nginx como estático. Recargar con caché
limpio (una ventana de incógnito nueva). Que la interfaz aparezca **en
castellano** es la señal de que el bloque quedó activo.

> **Por qué la barra recortada no es cosmética.** Sin `toolbarButtons`, al
> paciente le aparecen "Grabar", "Encuestas" e "Insertar reunión". Ninguna
> funciona para él —Jibri ni está instalado— pero **un paciente que ve un botón
> de grabar se pregunta si lo están grabando**. En una consulta médica eso no
> es un detalle de interfaz.

**Desde dónde se puede embeber.** En `/etc/nginx/sites-available/meet.biowellness.ar.conf`,
dentro del `server` de **443**, pegada al `Strict-Transport-Security` que el
paquete ya deja ahí:

```nginx
    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header Content-Security-Policy "frame-ancestors 'self' https://app.biowellness.ar https://dashboard.biowellness.ar;" always;
```

```bash
cp /etc/nginx/sites-available/meet.biowellness.ar.conf{,.bak}
sed -i "/add_header Strict-Transport-Security \"max-age=63072000\" always;/a\\    add_header Content-Security-Policy \"frame-ancestors 'self' https://app.biowellness.ar https://dashboard.biowellness.ar;\" always;" \
  /etc/nginx/sites-available/meet.biowellness.ar.conf
nginx -t && systemctl reload nginx
```

El patrón del `sed` lleva las comillas **dobles** a propósito: hay un segundo
`Strict-Transport-Security` en `location = /_unlock`, escrito con comillas
simples y con `includeSubDomains`, que así no se toca.

Los dos dominios son el portal del paciente y el Dashboard clínico
(`dashboard.biowellness.ar`, confirmado el 2026-09-16). **Sin esta línea
cualquier sitio de internet puede embeber el servidor de videollamadas en una
página propia**, que es exactamente lo que se usa para engañar a alguien sobre
con quién está hablando.

> **Por qué alcanza con ponerla en el `server` y no en cada `location`.**
> En nginx `add_header` **no se hereda** en un `location` que declare sus
> propios `add_header`: se pisan todos, no se suman. Este archivo tiene tres
> `location` que los declaran (los assets estáticos, `/_unlock` y
> `/conference-request/v1`), así que esos tres van a responder **sin** la CSP.
> No importa: `frame-ancestors` gobierna el documento que se embebe, y la
> página de la sala la sirve `location ~ ^/([^/?&:'"]+)$` → `@root_path`, que
> **no** declara `add_header` y por lo tanto sí hereda. Un CSS o un `.js` no se
> embeben en un iframe. Si algún día se le agrega un `add_header` a
> `@root_path`, hay que repetir la CSP ahí.

**Verificar que quedó** — contra una sala, no contra un asset:

```bash
curl -sI https://meet.biowellness.ar/tc-prueba | grep -i content-security-policy
```

Del lado del portal y del Dashboard hace falta además que **su** CSP permita el
iframe (`frame-src` y `script-src` con `meet.biowellness.ar`): son dos permisos
distintos, en dos servidores distintos, y hacen falta los dos.

⚠️ Si alguna vez aparece un `add_header X-Frame-Options` (hoy no está, ni en el
archivo ni en lo que trae `include /etc/jitsi/meet/jaas/*.conf`), hay que
**sacarlo**: no admite más de un origen y el navegador que lo entiende le da
prioridad, así que rompería el embebido en uno de los dos dominios.

**Logs sin PHI.** Las salas son UUIDs. El nombre visible aparece en Prosody en
nivel `debug`/`info`: dejar Prosody en `warn`.

**Sistema.**

```bash
apt install -y unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades
# SSH solo con clave: PasswordAuthentication no en /etc/ssh/sshd_config
```

## 6. coturn

Lo instaló y configuró `jitsi-meet-turnserver` en §3: escucha en 3478 y 5349, y
nginx debería multiplexar el 443 entre la web y TURN sobre TLS.

⚠️ **En la instalación real, `grep -rn stream /etc/nginx/modules-enabled/` no
devolvió nada**, así que el multiplexado de 443 no quedó armado. Es el último
recurso para redes corporativas que solo dejan salir por 443. Con 3478 y 5349
abiertos se cubre la mayoría de los casos, así que **se resuelve según el
resultado de la prueba 5** y no antes.

## 7. Pruebas de aceptación

| # | Prueba | Cómo | Esperado | Estado |
|---|---|---|---|---|
| 1 | Sin token | Abrir una sala sin `?jwt=` | Diálogo "Authentication required"; no entra | ✅ |
| 2 | Con token | Link firmado, en incógnito | Entra directo; el nombre visible sale del token | ✅ |
| 3 | Roles | Dos links (`member` y `owner`) en la misma sala | Solo el `owner` lleva la insignia de moderador | ✅ |
| 4 | **Permisos reales** | En la ventana del paciente: panel de participantes → tres puntos sobre el profesional | **Solo** "Fijar en el escenario" y "Enviar mensaje privado". Sin silenciar ni expulsar | ✅ |
| 5 | Red restrictiva | Una parte desde celular con **Wi-Fi apagado** (4G) | Video y audio fluidos en los dos sentidos | ⏳ |
| 6 | Relay por el servidor | **Tres** personas en la misma sala | Video fluido. Si falla y con dos andaba, es el NAT del JVB (§3.2) | ⏳ |
| 7 | iPhone embebido | La página mínima de abajo, en Safari y **agregada a la pantalla de inicio** | Pide cámara y micrófono y entra | ⏳ |
| 8 | Token vencido | Link con `exp` en el pasado | Rechazo | ⏳ |
| 9 | Sala equivocada | Token de una sala usado en otra | Rechazo | ⏳ |

> **La prueba 4 es la que vale, no la 3.** Los badges de Jitsi se parecen entre
> sí y se leen mal en una captura. Lo que no es ambiguo es **qué opciones le
> aparecen a cada uno sobre el otro**.

Página mínima para la prueba 7:

```html
<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://meet.biowellness.ar/external_api.js"></script>
<div id="sala" style="height:100vh"></div>
<script>
  new JitsiMeetExternalAPI('meet.biowellness.ar', {
    roomName: 'prueba',
    jwt: '<token member>',
    parentNode: document.getElementById('sala'),
  });
</script>
```

Mientras se sirve desde otro hosting hay que sumar ese dominio al
`frame-ancestors` de §5, y sacarlo después.

## 8. Operación

| Qué | Cómo |
|---|---|
| Reiniciar | `systemctl restart prosody jicofo jitsi-videobridge2 coturn nginx` |
| Ver qué pasa | `journalctl -u jicofo -f` · `tail -f /var/log/prosody/prosody.log` · `tail -f /var/log/jitsi/jicofo.log` |
| Actualizar | `apt update && apt upgrade`. Leer el changelog si cambia la versión mayor: los módulos de §4 son los que se rompen |
| Certificado | Se renueva solo (acme.sh con su cron). Verificar a los 60 días |
| Backup | `/etc/jitsi`, `/etc/prosody`, `/etc/nginx`, `/etc/turnserver.conf`. **No hay datos**: con esos cuatro y este runbook se reinstala en una hora |
| Monitoreo | Alarma de CloudWatch por CPU alta sostenida e instancia caída; chequeo externo de la URL cada 5 min |
| Dónde vive el secret | `/etc/prosody/conf.avail/meet.biowellness.ar.cfg.lua` y el Project Secret de Medplum. Rotarlo = cambiar en los dos y reiniciar Prosody |
| Cambiar el tamaño | Parar, cambiar tipo, arrancar. La Elastic IP se conserva |

> ⚠️ **`/etc/jitsi/jicofo/jicofo.conf` contiene la contraseña XMPP de Jicofo en
> texto plano.** Es una credencial interna y el puerto XMPP no está abierto en
> el security group, así que el riesgo es bajo — pero no pegar ese archivo
> entero en chats ni tickets.

## 9. Equivalente en Docker (camino B)

Mismo servidor, mismo DNS, mismo security group. En lugar de §3 y §4:

```bash
apt install -y docker.io docker-compose-v2
git clone https://github.com/jitsi/docker-jitsi-meet && cd docker-jitsi-meet
cp env.example .env && ./gen-passwords.sh
mkdir -p ~/.jitsi-meet-cfg/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb}
```

En el `.env`: `PUBLIC_URL`, `ENABLE_LETSENCRYPT=1`, `LETSENCRYPT_DOMAIN`,
`LETSENCRYPT_EMAIL`, `ENABLE_AUTH=1`, `AUTH_TYPE=jwt`, `JWT_APP_ID`,
`JWT_APP_SECRET`, `ENABLE_GUESTS=0`, `JVB_ADVERTISE_IPS`, `ENABLE_RECORDING=0`.

Lo que en A viene resuelto y en B hay que hacer a mano: **coturn** y el
multiplexado de 443, y los módulos y opciones de §4, que van en
`prosody-plugins-custom`. Las trampas de §13 aplican igual.

## 10. Costo (orden de magnitud)

`t3.medium` on-demand en `sa-east-1`, Elastic IP, 20 GB gp3 y tráfico de
salida. Para llamadas de dos personas el tráfico por el servidor es casi nulo
(punto a punto); cuando interviene TURN o hay tres o más, cuenta. Para el
piloto, **del orden de USD 50 a 70 por mes**: confirmar en la calculadora de
AWS y evaluar instancia reservada si el piloto sigue.

## 11. Lo que NO es de esta fase

Los cuatro bots, la página del portal (incluida la sala de espera de §4.4), el
botón del Dashboard, las policies y el catálogo. Todo eso es la **Fase 1** y
depende de que las ocho decisiones restantes de `teleconsulta.md` §10 estén
contestadas.

## 12. Checklist

- [x] Instancia en `sa-east-1` con Elastic IP y security group de §2
- [x] DNS apuntando y certificado válido
- [x] `jitsi-meet` y `jitsi-meet-tokens` instalados; secret generado y guardado
- [x] `allow_empty_token = false`
- [x] NAT del JVB configurado
- [x] Moderador por token: las tres piezas de §4.2, verificadas con la prueba 4
- [x] `config.js` endurecido y barra recortada
- [ ] `frame-ancestors` con los dos dominios — la línea está en §5; **falta aplicarla**
- [ ] Pruebas 5 a 9 de §7
- [ ] Decidir el multiplexado de 443 según el resultado de la prueba 5
- [ ] `unattended-upgrades` y SSH solo con clave
- [ ] Backup de los cuatro directorios de §8
- [ ] **Terminar la instancia de 26.04** que quedó del primer intento
- [ ] Rotar la contraseña XMPP de Jicofo (opcional; ver §8)

## 13. Trampas encontradas en la instalación real

Las que costaron tiempo, en orden de aparición. Están arriba en su lugar; acá
juntas para quien repita el procedimiento.

| # | Síntoma | Causa | Arreglo |
|---|---|---|---|
| 1 | El `curl` de la clave de Prosody no escribe nada | `/etc/apt/keyrings` no existe en una Ubuntu recién instalada | `mkdir -p /etc/apt/keyrings` antes |
| 2 | `Timeout during connect (likely firewall problem)` al pedir el certificado | El puerto **80** cerrado en el security group; ACME valida por HTTP | Abrir 80 TCP a `0.0.0.0/0` y reintentar |
| 3 | El 5349 no escucha | coturn no levanta TLS sin certificado | Aparece solo cuando el certificado se emite |
| 4 | `prosodyctl check config` "falla" | Devuelve código de error por **advertencias cosméticas** (opciones obsoletas en Prosody nuevo) | **No encadenarlo con `&&`**: el `systemctl restart` nunca corre y uno cree que aplicó |
| 5 | Se llega a "Join meeting" y parece que no hay control de acceso | El *prejoin* aparece **antes** del portero | El corte llega al apretar "Join": diálogo "Authentication required" |
| 6 | El paciente entra y **es moderador** | `mod_muc_wait_for_host` promueve a dueño a todo el que traiga token, pisando a `token_affiliation` | `wait_for_host_disable_auto_owners = true` (§4.2c) |
| 7 | El paciente no espera al profesional | Para ese módulo, anfitrión es cualquiera **con token**, y el paciente tiene uno | No se resuelve en Jitsi: la espera va al portal (§4.4) |
| 8 | Al paciente le aparece "Grabar" | Barra de herramientas por defecto | `toolbarButtons` acotado (§5) |

Dos cosas que **no** eran el problema y consumieron tiempo igual: `luajwtjitsi`
"faltante" (viene como `luajwtjitsi.lib.lua` dentro de los plugins, no como
paquete de `dpkg`, así que buscarlo con `dpkg -l` no sirve) y el mecanismo
`ANONYMOUS` que anuncia el endpoint BOSH (lo sigue anunciando con
autenticación por token, así que **no sirve como prueba**). La única prueba
válida del control de acceso es el navegador.
