# antiRea

**Defiende lo que realmente impulsa tu aplicación. No confíes en la ilusión de que la interfaz del cliente puede ocultarse de un navegador.**

**Conjunto de herramientas de evaluación de riesgos · SDK de TypeScript · Skill para agentes de IA**

[English](README.md) · [Tiếng Việt](README.vi.md) · [中文](README.zh.md) · [Threat Model](docs/THREAT_MODEL_REA.md) · [Limitations](docs/LIMITATIONS.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![cobertura de líneas de dist](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-810%20passing-informational)](tests/)

antiRea ayuda a auditar lo que expone un sitio web, aplicar cuotas de velocidad y paginación en el servidor, mover la lógica crítica al servidor y aplicar controles canary o de marca de agua donde corresponda. **No puede** impedir que usuarios o agentes inspeccionen el código entregado a su navegador.

## La historia breve

**Una aplicación web normal, sin protección.** Cualquiera con una cuenta puede llevarse los datos a casa. En nuestras pruebas, una cuenta y una sola llamada de exportación se llevaron todo el conjunto de datos de 10,000 registros en menos de 200 solicitudes - en silencio, sin dejar nada inusual.

**La misma aplicación con antiRea.** Los usuarios reales no notan nada. Pero los datos se miden por registro: una identidad solo puede recibir una porción limitada (20% del conjunto de datos en nuestra configuración de prueba), así que la extracción masiva deja de ser una exportación y se convierte en un problema de identidad. Si el trabajo se reparte entre muchas cuentas, el detector de grupos marca la coordinación. Resultado medido (ronda clásica de v2.5.0): la ejecución estilo REA que necesitó 1 cuenta sin protección fue **detenida en el 5% del conjunto de datos**, y un equipo de segmentación con scripts que insistió en terminar necesitó **25 identidades y ~19 minutos**, marcado tanto por el detector de grupos como por el motor de evidencia en el camino.

Sin protección, los datos salen **completos, gratis e invisibles**. Con protección, salen **en porciones, con un costo y con registro**. Las cifras completas están en [Resultados medidos](#funciona-resultados-medidos) más abajo.

Instala desde npm:

```bash
npm install @dannyphan190/anti-rea
```

También se puede instalar mediante [GitHub Release](https://github.com/dankezo/antiRea/releases).

## Novedades de v2.8.0

La versión corta: el guardián de salas que 2.7.3 decidió deliberadamente no publicar ya está aquí - reconstruido bajo un nuevo pin prerregistrado con la pata de ocupación que le faltaba - y llega con una capa de evidencia de cuatro módulos pequeños y exactos que fijan lo que significa el veredicto de cualquier otra señal: qué configuración lo produjo, qué prueba y qué no prueba la verificación de identidad, cómo se recuerda un step-up superado y qué evidencia puede fundamentar una consecuencia. Todo es aditivo y consultivo; nada cambia en la ruta por defecto.

- **El guardián, completo esta vez.** `createRoomGuard` evalúa una sala en ticks de 30 segundos a través de cuatro rutas congeladas: burst, sustained y churn (velocidad de entradas frente a la línea base de la propia sala, concentración de cuentas nuevas, inactividad tras la entrada, churn de salidas rápidas) más ocupación - la proporción de asientos mantenidos por cuentas nuevas y silenciosas, sostenida. En el pin de laboratorio RECOMB-06 (simulación con semillas, 20.161 ticks por celda), la presión nunca se activó en cinco celdas legítimas, incluida una audiencia de karaoke donde el 60% de las sesiones sentadas no dice ni una palabra; flood se marcó a los +60 s, drip a los +32,5 min, churn a los +30 s, y la ocupación de asientos que la combinación de 2.7.3 pasó por alto por completo se marcó a los +690 s gracias a la pata de ocupación. Su salida es un estado de la sala y una recomendación de step-up solo para entradas NUEVAS - los miembros ya sentados nunca son nombrados ni tocados. Un agujero queda declarado abierto en la documentación, no enterrado: un ocupante que envía incluso 1-2 mensajes sale de la definición de actividad cero de la pata de ocupación.
- **Una capa de evidencia, de cuatro disecciones.** `createConfigProvenance` (CS-02) aplica un hash a la configuración efectiva de una señal (serialización canónica más SHA-256) para que cada veredicto pueda nombrar el detector exacto que lo produjo - el puerto publicado reproduce los resúmenes de la sonda de laboratorio byte a byte. `classifyWebBotAuthVerdict` y `classifyHostVerificationFact` (BS-01) congelan la semántica verified-neutral: una identidad verificada mueve la sospecha exactamente 0, todo fallo ambiguo es "unverified", y solo la falsificación probada es evidencia. `issueStepUpProof` y `createStepUpProofVerifier` (CAP-01) dan a los anfitriones una prueba Ed25519 de un solo uso de que una identidad superó un desafío específico bajo una configuración específica. `evidentiaryRoleOf`, `auditEvidencePack` y `decorateSignalResult` (KT-01) escriben el rol probatorio de cada canal y hacen que un paquete de evidencia con solo corroboración sea mecánicamente inelegible para consecuencias.

Informe técnico completo: [Análisis detallado de v2.8.0](docs/v2.8.0-deep-dive.es.md). Lo que cambió la versión anterior: [Análisis detallado de v2.7.4](docs/v2.7.4-deep-dive.es.md).
## Entorno de pruebas comparativas en el navegador

El repositorio incluye un entorno de Playwright que ejecuta un SaaS sintético (**Northstar**: panel, búsqueda de clientes, creación de clientes potenciales, exportación CSV, vistas de gráficos) en modos **base (`:4173`)** y **protegido (`:4174`)** en Chromium, Firefox y WebKit - el complemento reproducible dentro del repositorio para los resultados medidos que siguen.

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

## ¿Qué problema aborda antiRea?

Herramientas como [morluto/rea](https://github.com/morluto/rea) ayudan a observar la estructura del DOM, analizar paquetes de JavaScript, rastrear el tráfico de red y reconstruir la interfaz de aplicaciones web.

El objetivo de este proyecto es ayudar a los propietarios de aplicaciones a implementar **medidas efectivas con efectos secundarios mínimos**, respaldadas por pruebas comparativas reproducibles y no por seguridad por oscuridad.

## ¿Funciona? Resultados medidos

**Método, en breve.** Probamos contra **Ledgerly**, un SaaS sintético que contiene 10,000 registros detrás de 120 cuentas, ejecutado dos veces: una instancia base sin protección y una instancia protegida de la *misma* aplicación con antiRea integrado. Las ejecuciones de ataque son impulsadas por REA 6.8.0 (`rea-agents`) y por agentes de propósito general que siguen el flujo estándar de clonación; las ejecuciones de control con usuarios corteses miden el costo para el tráfico legítimo. También se publicó una evaluación comparativa independiente de este repositorio en [issue #1](https://github.com/dankezo/antiRea/issues/1); la mayoría de las afirmaciones se sostuvieron, y las brechas que encontró están corregidas y registradas en el registro de cambios. La nota completa de método y la tabla completa por capa están en [docs/EVIDENCE.es.md](docs/EVIDENCE.es.md).

| Capa | Resultado principal |
|---|---|
| Sin protección (base) | El conjunto completo de 10,000 registros sale en **160-193 solicitudes** |
| Presupuesto de registros | Una identidad queda limitada a exactamente el **20%** del conjunto de datos |
| Detector de grupos + evidencia CUSUM | La rotación de identidades estilo REA se detuvo en el **5%**; un equipo adaptativo necesitó **25 identidades y ~19 minutos** |
| Límite de cohorte declarada | La unión de la cohorte se detuvo en exactamente **600 registros**, cero servidos más allá del techo |
| Usuarios legítimos | Equipo declarado **1,200/1,200 con cero fricción**; usuarios corteses, cero consecuencias |
| Presupuesto de acciones (laboratorio) | El grupo de abuso de funciones completó **16/80 operaciones (20.0%)**; usuarios comunes **48/48**, cero consecuencias |
| Señales consultivas (laboratorio) | Cinco señales para formas lentas: **0-1.67%** de falsos marcados sobre tráfico legítimo - cifras por señal en la tabla completa |

Tabla completa por capa, incluidos los puntos ciegos registrados dentro de sus propias celdas: [docs/EVIDENCE.es.md](docs/EVIDENCE.es.md).

**Lo que esto significa en conjunto.** La pila elimina la clonación casual de un solo intento y convierte la extracción masiva en un problema de identidad: cada porción adicional del conjunto de datos cuesta otra cuenta y más visibilidad. No detiene a quien reconstruye con determinación y buenos recursos, y el precio real de una identidad (fricción de registro, cuentas verificadas, pago) lo define el host - por eso los presupuestos se aplican por identidad y por eso las marcas de grupo distinguen entre "recortar el presupuesto" y "aumentar el escrutinio" en lugar de disparar una única respuesta contundente.

## Cuatro niveles y prioridad de implementación

| Prioridad | Función | Beneficio esperado | Límite |
|---|---|---|---|
| **P0 - Base** | Middleware de cuota/paginación en el servidor (`createQuotaGuard`), autorización por registro, aislamiento de secretos | Garantía central contra extracción y clonación | No puede ocultar datos ya servidos a un usuario autorizado |
| **Nivel 1** | Ocultar mapas de código fuente públicos (`verify-build.py` / `run-audit.cjs`); avisos de derechos de autor; firmas de procedencia en SVG/texto | Evita la exposición accidental del código fuente completo | Fácil de eliminar por usuarios decididos |
| **Nivel 2** | Trampas canary de API normalizadas (`handleCanaryTrapRequest`), un laberinto canary determinista (`createCanaryMaze`), rutas señuelo (`createDecoyMirage`), telemetría de automatización de baja confianza (`detectAutomationSignals`) y verificación de firmas Web Bot Auth (`createWebBotAuthVerifier`) para agentes que firman sus solicitudes | Registra exploraciones anómalas para revisión; identifica agentes firmados para que la política de cuotas pueda basarse en una identidad estable | No es un control de acceso bloqueante; una firma verificada es identidad, no autorización |
| **Nivel 2 - Economía de datos** | Presupuesto por registro (`createRecordBudget`), exportaciones valoradas (`createExportGuard`), cursores encadenados por sesión (`mintCursor` / `verifyCursor`), puntuación de flujo por secuencia (`createFlowScorer`) | Limita cuánto del conjunto de datos puede recibir una identidad; hace que la extracción completa cueste muchas identidades (medido: límite de 20% por identidad en nuestras pruebas) | Los atacantes rotan identidades - combinar con un costo real de registro del lado del host |
| **Nivel 2 - Detección de grupos** | Detector de grupos entre identidades (`createHerdDetector`) con escalera de respuesta (`applyHerdLadder`) | Marca grupos de identidades que en conjunto cubren el conjunto de datos, incluso entre IP; los grupos de cobertura alta reciben recortes de presupuesto, los de cobertura baja reciben respuesta gradual | La detección no es aplicación para grupos de cobertura baja - un grupo adaptativo disciplinado fue marcado y aun así terminó (ver resultados medidos) |
| **Nivel 3** | Sobres AES-GCM vinculados al contexto (`encryptPayload` / `decryptPayload`) con protección acotada contra reutilización (`createInMemoryReplayGuard`) | Evita la reutilización simple entre endpoints | El cliente aún conserva el contexto de descifrado si la clave está en el navegador |
| **Nivel 4** | Superposición de marca de agua con token efímero (`mountForensicWatermark`) | Trazabilidad para capturas de pantalla filtradas | Las superposiciones en pantalla pueden recortarse o editarse |

**Recomendación predeterminada:** Implementa primero P0 y luego configura el Nivel 1. Para API clave, activa cuotas de servidor y trampas canary.

## Instalación y pruebas

Requiere Node.js 20+. El repositorio **no tiene dependencias en tiempo de ejecución**; TypeScript es una dependencia de desarrollo para la compilación.

```bash
npm install
npm run check
npm run build
```

`npm run check` compila, ejecuta **812 pruebas automatizadas** (810 superadas, 2 vectores RSA-PSS omitidos) y realiza comprobaciones estáticas. Escanea el directorio público de compilación antes del despliegue con `node scripts/run-audit.cjs /path/to/dist` o `python3 scripts/verify-build.py /path/to/dist`.

## Cómo integrar el SDK

### 1. Control de cuota y paginación en el servidor P0 (recomendado primero)

```ts
import { createExpressQuotaMiddleware } from "@dannyphan190/anti-rea";

app.use("/api/", createExpressQuotaMiddleware({
  trustedIpHeader: "cf-connecting-ip",
  tiers: {
    anonymous: { maxRequests: 30, windowMs: 60_000, maxPageSize: 25, maxPage: 5 },
    free: { maxRequests: 60, windowMs: 60_000, maxPageSize: 50, maxPage: 20 },
    pro: { maxRequests: 300, windowMs: 60_000, maxPageSize: 200, maxPage: 100 },
  },
  resolveIdentity: req => ({
    accountId: req.headers.get("x-verified-account") ?? undefined, // populate from server auth middleware
    apiKeyId: req.headers.get("x-verified-key-id") ?? undefined,
    tier: "free",
  }),
  onQuotaExceeded: event => {
    console.warn("[quota-exceeded]", event);
  },
}));
```

Devuelve HTTP `429` con `Retry-After` cuando se superan los umbrales de cuenta, clave de API o IP, aplica límites de `limit`/`pageSize` y `page`/`offset`, y registra eventos estructurados para los operadores.

### 2. Endpoints canary del servidor (con canonicalización de URL)

```ts
import { handleCanaryTrapRequest, normalizeCanaryPath } from "@dannyphan190/anti-rea";

const result = await handleCanaryTrapRequest(request, {
  onAlert: async event => { /* send sanitized event to your monitoring platform */ },
  resolveUserId: () => trustedServerSession.userId,
});
if (result.isTrapped) return Response.json(result.body, { status: result.status });
```

`normalizeCanaryPath` canonicaliza automáticamente las barras finales, las rutas en mayúsculas y los caracteres codificados en porcentaje (`%2D`, `%5F`) para que las variantes de ruta no puedan eludir la coincidencia exacta.

### 3. Marca de agua opcional para vistas previas autenticadas

```ts
import { mountForensicWatermark } from "@dannyphan190/anti-rea";
const remove = mountForensicWatermark({ token: "A7fK3w9Z", enabled: true });
// Resolve that token to a session only in your private server ledger.
```

No incrustes el correo electrónico, la IP o el ID de usuario sin procesar de la persona en los píxeles. Proporciona un aviso de privacidad y una política de retención.

### 4. Sobres avanzados: claves propiedad del servidor y control de reutilización acotado

```ts
import {
  createEnvelopeKey,
  encryptPayload,
   verifyTransportEnvelope,
  createInMemoryReplayGuard,
} from "@dannyphan190/anti-rea";

const key = await createEnvelopeKey();
const scope = { purpose: "report-export", method: "POST", path: "/api/export", sessionBinding: "trusted-session-id" };
const env = await encryptPayload({ result: "ok" }, key, scope);

// Automatically purges expired nonces by TTL and caps entries to prevent unbounded RAM growth
const replayGuard = createInMemoryReplayGuard({
  ttlMs: 300_000,
  maxEntries: 10_000,
});

const decoded = await verifyTransportEnvelope(env, key, scope, { markNonceOnce: replayGuard });
```

Usa este patrón para servicios de servidor controlados de forma independiente o protocolos de sesión diseñados con cuidado (usa Redis `SET ... NX PX` en clústeres con múltiples instancias).

### 5. Verificar agentes firmados (Web Bot Auth)

Algunos rastreadores y agentes de IA firman sus solicitudes según el perfil Web Bot Auth (RFC 9421, Ed25519). El verificador reconstruye y comprueba la firma, aplica la ventana de validez y rechaza los nonces reutilizados. Nunca obtiene claves por sí mismo - las claves se suministran de forma estática o mediante un resolvedor propio (obtener `/.well-known/http-message-signatures-directory` desde el origen del agente con caché y política contra SSRF propias).

```ts
import { createWebBotAuthVerifier } from "@dannyphan190/anti-rea";

const verifier = createWebBotAuthVerifier({
  resolveKey: async ({ agent }) => {
    if (!agent) return undefined;
    const res = await fetch(new URL("/.well-known/http-message-signatures-directory", agent));
    return res.ok ? await res.json() : undefined;
  },
  maxValiditySeconds: 600, // tighten the draft's 24h ceiling
});

const verdict = await verifier.verify(request);
if (verdict.verified) {
  // verdict.agent / verdict.keyId identify the signer of THIS request.
  // Feed the identity into your quota tier decision - and keep your
  // authorization checks exactly as they are for unsigned traffic.
}
```

Una demostración completa ejecutable (generar una clave, firmar una solicitud, verificar, luego alterarla y ver cómo falla) está en [examples/web-bot-auth-verify.cjs](examples/web-bot-auth-verify.cjs).

### 6. Python / FastAPI

¿Se ejecuta un backend en Python? [examples/python-fastapi](examples/python-fastapi) adapta el control de cuota con los mismos niveles, la misma semántica `429`, encabezados `X-RateLimit-*` y límites de paginación, además de un middleware de Starlette y dependencias de FastAPI. Su suite de pytest refleja los escenarios de prueba de TypeScript, así que ambas implementaciones cumplen el mismo contrato.

### 7. Medir los datos en sí (presupuesto de registros + detección de grupos)

Las cuotas de solicitudes limitan la *velocidad*; un presupuesto de registros limita *cuánto del conjunto de datos* puede recibir una identidad, por cortés que sea su paginación. Alimenta el detector de grupos con los mismos eventos de servicio para que los grupos coordinados también salgan a la luz.

```ts
import { createRecordBudget, createHerdDetector } from "@dannyphan190/anti-rea";

// One identity receives at most 2,000 distinct records per day.
const budget = createRecordBudget({ maxDistinctPerWindow: 2_000 });
const herd = createHerdDetector({
  onFlag: snap => { /* snap.band: "budget_cut_supported" | "graduated_only" */ },
});

// Gate before the handler runs, then record what the response actually served:
if (!budget.check("account:123", 1).allowed) { /* return 429 */ }
// ... handler runs, authorization passes, recordIdsServed is final ...
budget.consume("account:123", recordIdsServed);
herd.observe({ type: "list", identity: "account:123", ip: serverSeenIp, recordIds: recordIdsServed });
```

Usa la misma cadena de identidad (`account:<id>`) en ambos, para que una marca de grupo pueda alimentarse directamente en `applyHerdLadder()` o en una anulación de presupuesto.

### 8. Límites compartidos y evidencia (v2.5.0)

Para cohortes, los presupuestos por identidad se diluyen con la rotación; un límite compartido no - pero solo si la reserva es transaccional. Declara la cohorte, reserva antes de servir, confirma después:

```ts
import {
  createDisclosureLedger, createInMemoryTransactionalStore,
  createCusumTripwire, clampEnforcement, consequenceTargets,
  createProtectedCohortRegistry, defaultHerdBandResponse, herdFrictionTargets,
} from "@dannyphan190/anti-rea";

const ledger = createDisclosureLedger({
  store: createInMemoryTransactionalStore(), // CAS store => mode "enforce"
  ceilingLimit: 2_000,                        // shared across the whole cohort
});
await ledger.declareRegistry(memberIds);      // unregistered subjects fail closed

const reservation = await ledger.reserveDisclosure({ subject: "account:123", recordIds: idsToServe });
if (!reservation.allowed) { /* 429: ceiling_exceeded | rate_limited | ... */ }
// ... serve ...
await ledger.commitReservation(reservation.reservationId);

// Declare the subjects inference must never consequence: the
// compliance team's reviewers, the support floor, an agreed pentest
// window. Their telemetry still accrues - only consequences are
// suppressed - and the declaration is an auditable record.
const protectedCohorts = createProtectedCohortRegistry();
protectedCohorts.declareProtected(["account:auditor-1", "account:auditor-2"], {
  reason: "Q3 compliance review",
});

// Evidence accumulates separately. The tripwire's default mode is
// enforce, but with the bundled uncalibrated tables an inferred
// cohort's consequence is capped at the friction tier (step-up, plus
// a soft budget step-down that never goes below 500 records).
// Anything harder needs a host-declared cohort or a ceiling-tier
// calibration manifest - clampEnforcement() is the check.
const tripwire = createCusumTripwire({ isProtected: id => protectedCohorts.isProtected(id) });
await tripwire.observe({ type: "list", identity: "account:123", recordIds: idsToServe });

// Herd flags get the same default: for an inferred cohort,
// defaultHerdBandResponse() returns friction (stepUp: true,
// budgetStepDownFloorRecords: 500, ladder: false) on both bands.
// Apply that friction only to the members who produced the
// evidence (2.5.0): herdFrictionTargets(snap) keeps members whose
// unique coverage is material, consequenceTargets(snapshot)
// keeps net contributors - then partition through the registry
// so protected subjects stay at zero.

// Canary-echo (2.5.0): mint a signed reference FOR this identity
// and embed it in its own surface (a record, a hidden link); when
// a different identity presents it back, link the two cohorts.
const echoId = mintEchoId(secret, { mintedFor: "account:123" });
const ref = mintEchoRecord(secret, { mintedFor: "account:123" });
// ...later, on the detail route, before the record lookup:
const echoFrom = resolveEchoFrom(secret, presentedId);
if (echoFrom && echoFrom !== identity) {
  await tripwire.observe({ type: "detail", identity, echoFrom });
}
```

Con un almacén de solo get/put, el libro informa `mode: "audit_only"` y `enforced: false` en cada decisión - mide primero, aplica cuando el almacén realmente pueda realizar transacciones. Semántica completa y límites: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Piloto de calibración

El motor de evidencia CUSUM de antiRea se distribuye con tablas ajustadas en laboratorio
(`r6-calib-1`, etiquetadas `uncalibrated: true`): fueron ajustadas sobre
trazas con scripts, no sobre una población real de usuarios, y el README lo indica
dondequiera que se mencionan esas tablas. Cerrar esa brecha necesita
exactamente una cosa que este proyecto no puede generar por sí mismo - instantáneas
en modo de observación de un host real.

**Ejecuta un piloto de calibración.** Si se usa antiRea (o se está evaluando),
ejecuta el tripwire CUSUM en `mode: "observe"` - los cruces se
registran y nada se restringe - y comparte las
**instantáneas agregadas y anonimizadas** resultantes: tamaños de cohorte, puntuación y
conteos de registros de unión en los cruces, la misma forma de resumen que el callback
`onCampaignFlag` del SDK ya emite.

- Solo instantáneas agregadas y anonimizadas - **sin datos sin procesar de usuarios, sin
  contenido de registros, sin identificadores por los que los usuarios puedan ser reconocidos**.
  Revisa y limpia una instantánea antes de enviarla; si un campo
  parece identificativo, omítelo e indícalo.
- Las instantáneas entran en el ajuste de calibración sin conexión; una tabla ajustada sobre
  instantáneas de población real es la forma de retirar la etiqueta `uncalibrated`,
  con el método de ajuste y los resultados de reserva publicados en el
  registro de cambios.
- Un host basta para empezar: el primer conjunto real de instantáneas es el
  primer dato de población real que este proyecto ha tenido.

¿Interés, o se desea primero el formato de instantánea? Escribe a
**dannyphan190@gmail.com**.

## ¿Por qué no "bloquear CDP" o inyectar prompts maliciosos?

El antiguo truco de serialización de `Error.stack` fue debilitado por cambios en V8; la investigación independiente documenta las limitaciones del bloqueo del lado del cliente. Las inyecciones de prompts en el DOM son datos no confiables, no un control de seguridad fiable ni ético. Ver [referencias](docs/REFERENCES.md).

## Contribución / Seguridad / Limitaciones

Lee [CONTRIBUTING.md](.github/CONTRIBUTING.md), [SECURITY.md](.github/SECURITY.md), [docs/LEGAL_PRIVACY.md](docs/LEGAL_PRIVACY.md) y [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

**Financiación del proyecto:** [Apoya al mantenedor](https://www.paypal.com/paypalme/dannyphan190) (opcional; nunca necesario para usarlo).
