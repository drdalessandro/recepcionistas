# Auditoría (`AuditEvent`) — activación, IP y purga

> **Decidido por Andrés el 2026-09-21**: se activa, **con la purga definida
> desde el día uno**, y el `AuditEvent` tiene que guardar **la IP del cliente**,
> no la del proxy.

Contesta una sola pregunta: *si mañana alguien impugna una firma, ¿qué podemos
mostrar?* La trajo el handoff del portal
([`handoff-portal-consentimiento.md`](handoff-portal-consentimiento.md) §8.3),
que encontró que el servidor ya sabe hacer esto y nosotros lo dábamos por
imposible.

Todo lo que sigue está verificado contra el código del servidor **en la versión
que corre en producción, 5.1.39** — no contra la documentación, que en este
tema ya nos mintió una vez (`cronTimer`).

## 1. Qué hace el servidor, y dónde lo dice

| Flag | Qué hace | Dónde |
|---|---|---|
| `logAuditEvents` | Manda cada evento al stream de logs. | `packages/server/src/config/types.ts:75` |
| `saveAuditEvents` | **Los persiste como recursos FHIR `AuditEvent`.** Es el que importa. | `types.ts:76` |
| `redactAuditEvents` | Borra el `display` de las referencias del evento. | `types.ts:176` |

`Repository.logEvent` (`fhir/repo.ts:2310`) se llama en create, read, vread,
history, update, delete, patch y search. La **única** exclusión es
`if (isSystem && (isReadOnlyAction(subtype) || resourceType === 'AuditEvent'))`:
solo tapa las lecturas hechas con identidad `system` y la auditoría sobre sí
misma **cuando el autor es system**. Un bot no es `system` — ver §5.

El evento guarda `agent.network.address` con la IP
(`util/auditevent.ts:231-233`), `who`, `entity.what`, el subtipo, el resultado y
la duración.

**Sobre `redactAuditEvents`**: lo recomendamos en `true`. El evento sigue
identificando el recurso por referencia (`Patient/abc`), que es lo que sirve
como prueba, pero deja de arrastrar el **nombre** de la paciente al `display`.
Es el principio 3 del `CLAUDE.md` aplicado a un registro que va a ser largo y
que mira más gente que la historia clínica. Se puede poner global o por
proyecto (`Project.setting` con `name: 'redactAuditEvents'`).

## 2. La IP del cliente — ya funciona, y por qué

Esta era la parte con riesgo real: detrás de nginx, si nadie confía en el
proxy, **todos** los eventos guardan `127.0.0.1` y la evidencia no sirve para lo
único que se la quiere. Están las dos mitades:

- **nginx**: [`deploy/nginx-api-proxy.conf`](../deploy/nginx-api-proxy.conf)
  frontea TODA la API (`location /` → `127.0.0.1:8103`) y manda `X-Real-IP` y
  `X-Forwarded-For` en **cada** `location`, webhooks incluidos.
- **Medplum**: `app.set('trust proxy', 1)` está **hardcodeado** en
  `packages/server/src/app.ts:197`. No es configurable y no hay que tocar nada.

Con `trust proxy = 1`, Express toma **el último salto** del `X-Forwarded-For`.
Es lo correcto para nuestro armado (nginx → node, un solo salto) y conviene
saberlo si algún día se mete algo adelante: **con un CDN o un balanceador
delante de nginx, la IP registrada pasaría a ser la de ese intermediario** y
habría que revisarlo.

## 3. La purga — `bw-purgar-auditoria`

Un evento por cada interacción, lecturas incluidas, y la app de Recepción sola
relee Avisos cada 30 segundos: sin purga, la tabla no tiene techo. **Dos
plazos**, en `src/lib/auditoria.ts`:

| Qué | Plazo | Por qué |
|---|---|---|
| **Escrituras** (`create`/`update`/`delete`/`patch`) sobre `Consent` o `DocumentReference` | `RETENCION_FIRMA_DIAS` = **3653** (10 años) | Es *la* evidencia: quién creó la firma, cuándo y desde qué IP. El día que se impugne puede caer años después. Diez años es el plazo que la Ley 26.529 (art. 18) le pone a la historia clínica — el criterio es de Andrés y se cambia acá. |
| **Todo lo demás**, incluidas las **lecturas** de esos mismos recursos | `RETENCION_DIAS` = **90** | `bw-estado-consentimiento` lee el consentimiento en cada apertura de ficha y en cada reserva: guardar diez años de eso cuesta como guardar la evidencia mil veces y no prueba nada sobre quién firmó. Noventa días alcanzan para lo que una lectura sí contesta — si alguien miró algo que no debía. |

Los dos son constantes: cambiarlos es una línea y un `deploy:bots`.

**Falla cerrado**: un evento sin fecha, o con una fecha ilegible, **se
conserva**. Entre guardar de más y borrar evidencia, se guarda de más.

**Acotado por corrida.** Un bot corre en Lambda con tope de tiempo, así que la
purga borra hasta `maxBorrados` (500 por defecto) y vuelve mañana. `quedaTrabajo`
en el resultado dice si quedó cola. Cron: `40 4 * * *`, de madrugada, porque es
borrado masivo y no tiene por qué competir con el horario de atención.

**El cursor no es decorativo.** Se pagina por `_lastUpdated` ascendente
avanzando un cursor. Sin eso, los eventos que se *conservan* (la evidencia)
quedan para siempre al frente de la primera página y la purga nunca llega a los
de atrás: un bucle que reporta éxito sin borrar nada. Hay test.

## 4. Puesta en marcha, en orden

El orden importa: **la IP primero, la purga antes de activar**. Si se activa sin
purga, se acumulan meses de eventos y alguien los borra a mano con un script;
si se activa antes de verificar la IP, se acumulan meses de eventos con
`127.0.0.1` y no hay forma de recuperarlos.

1. **Deployar la purga** (todavía no hay nada que purgar, y queda lista):
   ```bash
   npm run deploy:bots     # crea y deploya bw-purgar-auditoria
   npm run bots:cron       # y con --apply le escribe el cron
   ```
   El bot necesita **leer y borrar `AuditEvent`**. Si no lo tiene, su primera
   corrida devuelve `ok: false` con el mensaje del servidor en vez de reportar
   cero borrados, que se leería como "estaba limpio".
2. **Activar el flag** en la config del servidor. Medplum la carga con
   `file:medplum.config.json`, `aws:<path de SSM>`, `env` o una combinación
   (`config/loader.ts:35-43`), y elige la fuente por el **argumento con el que
   arranca el proceso** (`index.ts:63`; sin argumento, `file:medplum.config.json`
   relativo a su cwd). O sea que lo primero es averiguar **cuál usa esta
   instancia**, no inventar un archivo nuevo:

   ```bash
   pm2 describe <nombre>       # "script args" y "exec cwd" dicen cuál y dónde
   ```

   Si es un archivo (el caso normal):

   ```bash
   cd <exec cwd>
   cp medplum.config.json medplum.config.json.bak-$(date +%F)   # primero la red
   nano medplum.config.json                                      # agregar las dos claves
   python3 -m json.tool medplum.config.json > /dev/null && echo "JSON válido"
   pm2 restart <nombre> && pm2 logs <nombre> --lines 40
   ```

   Las dos claves, al mismo nivel que el resto (⚠️ **es JSON estricto**: sin
   comentarios y sin coma de más al final):

   ```json
   "saveAuditEvents": true,
   "redactAuditEvents": true
   ```

   Si `pm2 describe` muestra `aws:` es SSM Parameter Store: las claves son dos
   parámetros bajo ese prefijo, y se cargan con
   `aws ssm put-parameter --name "<prefijo>saveAuditEvents" --value "true" --type String --overwrite`.

   **Volver atrás** es poner `false` y reiniciar; lo ya guardado no se borra
   solo (lo purga `bw-purgar-auditoria` cuando cumpla su plazo).

   > No hay endpoint que devuelva la config, así que **que el flag tomó se
   > comprueba con el paso 3**: si aparecen `AuditEvent` nuevos, está activo.
3. **Prueba de humo de la IP** — esto es lo que no se puede saltear:
   - Entrar a la app de Recepción y abrir una ficha, desde una conexión cuya IP
     pública se conozca (el celular con datos móviles, **con el WiFi apagado**:
     desde la red del centro se vería la IP del centro y no se probaría nada).
   - Correr el diagnóstico, que contesta las dos preguntas de una — si el flag
     tomó (hay eventos) y si la IP es la del cliente:
     ```bash
     npm run auditoria:check
     ```
     Imprime los últimos eventos con fecha, tipo, IP, quién y sobre qué recurso,
     el total guardado, y un veredicto. Sale con código 1 si algo está mal.
   - A mano, si se prefiere el admin: `AuditEvent?_sort=-_lastUpdated&_count=5`.
   - Mirar `agent[0].network.address`. **Tiene que ser la IP de esa conexión.**
     Si dice `127.0.0.1`, la cadena del proxy está cortada: no seguir, revisar
     §2 antes de dejar que se acumule.
4. **Primera corrida en seco**, para ver el volumen real antes de borrar:
   ejecutar el bot desde el admin con `{ "dryRun": true }`. Devuelve cuántos
   borraría sin tocar nada.
5. **A los pocos días, mirar el crecimiento.** Es el número que decide si 90
   días es el plazo correcto o hay que bajarlo.

## 5. Dos cosas que sorprenden

**La purga se audita a sí misma.** La exclusión de Medplum tapa los
`AuditEvent` sobre `AuditEvent` solo cuando el autor es `system`, y un bot no lo
es: cada borrado deja su propio evento de `delete`. No es un bucle infinito
—esos eventos son de hoy y recién serán purgables dentro de 90 días, y para
entonces los borra una corrida futura— pero explica por qué los números no
bajan tanto como uno esperaría en las primeras corridas.

**Esto no reemplaza el hash.** La integridad del documento firmado la prueba el
`hash` del adjunto contra la **versión 1** del recurso (`/_history`), no el
`AuditEvent`. Son dos pruebas distintas y hacen falta las dos: el hash dice que
el texto no cambió, la auditoría dice quién lo escribió, cuándo y desde dónde.

## 6. El día que haga falta

Para una firma concreta, tres consultas en el admin:

```
Consent?patient=Patient/<id>                       → el hecho jurídico
DocumentReference/<id>/_history                    → la versión 1 y su hash
AuditEvent?entity=DocumentReference/<id>           → quién la escribió y leyó
```

De la tercera salen `recorded` (cuándo), `agent.who` (quién) y
`agent.network.address` (desde qué IP).

## 7. Lo que queda abierto

**`Provenance` con `Signature`.** Es el recurso que FHIR tiene para firmar, y la
propia definición de `Attachment.hash` remite a él. Hoy no existe en ningún
flujo. Cuando se haga, **lo escribe un bot** y no el paciente —coincidimos con
el portal en eso—: es el mismo criterio por el que `bw-ingreso-presencial`
existe en vez de darle escritura de `Consent` a Recepción. No amplía la
superficie de escritura de nadie.
