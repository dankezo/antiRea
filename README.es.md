# antiRea

**Defiende lo que realmente impulsa tu aplicación. No confíes en la ilusión de que la interfaz del cliente puede ocultarse de un navegador.**

**Conjunto de herramientas de evaluación de riesgos · SDK de TypeScript · Skill para agentes de IA**

[English](README.md) · [Tiếng Việt](README.vi.md) · [中文](README.zh.md) · [Threat Model](docs/THREAT_MODEL_REA.md) · [Limitations](docs/LIMITATIONS.md) · [Changelog](CHANGELOG.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg)](https://www.npmjs.com/package/@dannyphan190/anti-rea)
[![CI](https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg)](https://github.com/dankezo/antiRea/actions/workflows/ci.yml)
[![cobertura de líneas de dist](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/dankezo/antiRea/badges/badges/coverage.json)](https://github.com/dankezo/antiRea/blob/main/docs/LIMITATIONS.md)
[![tests](https://img.shields.io/badge/tests-336%20passing-informational)](tests/)

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

## Novedades de v2.6.3

Una versión de parche que corrige los ocho problemas de gravedad media encontrados por la auditoría independiente de la v2.6.0. Sin funciones nuevas y sin pasos de actualización: los mismos límites que ya configuró ahora se aplican también en algunos puntos donde antes había huecos.

- **Los límites de cuota y de exportación ahora se aplican de forma atómica con el almacén incluido.** Antes, un almacén lento dejaba que las solicitudes paralelas se adelantaran entre sí y superaran el tope. Ahora comprobar y registrar es un solo paso.
- **Las exportaciones CSV ahora se cobran como las JSON.** Antes, un cuerpo CSV se valoraba en cero por accidente: en una prueba en vivo extrajo 150 registros a través de un límite de 60. Ahora todos los formatos de exportación pagan igual.
- **Una acción sin precio declarado se rechaza en lugar de ser gratuita.** Si su aplicación olvidaba poner precio a una acción, antes se ejecutaba gratis para siempre. Ahora se rechaza hasta que tenga un precio (o hasta que usted fije un precio de reserva).
- **Un callback del anfitrión que falla ya no pierde una marca de aviso.** Si su gestor de notificaciones lanzaba un error, la marca desaparecía. Ahora se conserva y se vuelve a entregar en el siguiente contacto.
- **Una entrada NaN ya no bloquea un grupo de usuarios para siempre.** Un número malformado antes envenenaba el contador de un grupo hasta el reinicio. Ahora se rechaza en el acto y el contador se repara solo.
- **La memoria de seguimiento tiene tope y se limpia sola.** El estado de seguimiento por identidad ahora tiene un límite de tamaño y expulsa las entradas menos activas, en lugar de crecer sin fin.
- **La rotación de calibración ahora sí restablece las puntuaciones.** Cuando una ventana de evidencia cambia de periodo, las puntuaciones y contribuciones antiguas se borran de verdad: antes quedaban y podían volver a marcar un grupo al instante.
- **La suite de pruebas creció para demostrarlo:** 338 pruebas, 336 superadas, incluidas 16 pruebas nuevas que fallan todas con el código anterior al parche.

Informe técnico completo: [Análisis detallado de v2.6.3](docs/v2.6.3-deep-dive.es.md). El endurecimiento de relojes de la v2.6.2 está cubierto en el [análisis detallado de la v2.6.2](docs/v2.6.2-deep-dive.es.md) y en el registro de cambios.

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

**Método.** Probamos contra **Ledgerly**, un SaaS sintético que contiene 10,000 registros detrás de 120 cuentas, ejecutado dos veces: una instancia base sin protección y una instancia protegida de la *misma* aplicación con antiRea integrado. Las ejecuciones de ataque son impulsadas por REA 6.8.0 (`rea-agents`) y por agentes de propósito general que siguen el flujo estándar de clonación: autenticarse, enumerar, explorar límites, paginar hasta cobertura completa, exportar en ráfagas. (Un hallazgo da forma a todo lo que sigue: REA en sí solo *percibe* - lee un navegador en ejecución mediante CDP y no envía ninguna solicitud por sí mismo. El comportamiento que un servidor puede observar, medir y valorar es el flujo que lo impulsa, así que las defensas apuntan a eso.) Las ejecuciones de control con usuarios corteses miden el costo para el tráfico legítimo. También se publicó una evaluación comparativa independiente de este repositorio en [issue #1](https://github.com/dankezo/antiRea/issues/1); la mayoría de las afirmaciones se sostuvieron, y las brechas que encontró están corregidas y registradas en el registro de cambios.

| Capa | Qué medimos | Resultado |
|---|---|---|
| Sin protección (base) | Extracción completa del conjunto de datos de 10,000 registros | **160-193 solicitudes en total**; una sola llamada de exportación devuelve todo |
| Cuota P0 + límites de paginación | Abuso de exportación y paginación | Las exportaciones masivas son rechazadas (HTTP 422), el tamaño y la profundidad de página están limitados - necesario, pero no suficiente por sí solo |
| Presupuesto de registros + control de exportación + cursores encadenados | Cuánto puede tomar una identidad (presupuesto fijado en 2,000 registros distintos/día) | El límite por identidad se mantuvo en exactamente **20% del conjunto de datos**; se bloqueó la reutilización de cursores entre sesiones; la extracción completa ahora necesita muchas identidades en lugar de una cuenta |
| Detector de grupos + motor de evidencia CUSUM | Extracción coordinada con múltiples identidades (ronda clásica de v2.5.0) | Una rotación de identidades estilo REA fue detenida en el **5%** del conjunto de datos; los equipos de segmentación y de recorrido de ID fueron marcados por AMBOS detectores - los primeros cruces del motor de evidencia llegaron a **1,800** y **900** registros de unión (ambas formas eran invisibles para él antes de 2.5.0), y el conjunto de marcas/consecuencias del detector de grupos cubrió a **18/18** identidades de segmentación de la fase 1 (8 de 18 en 2.4.0). Las marcas de grupo llevan cobertura por miembro, así que los miembros con contribución cero de un grupo marcado no reciben fricción (medido en la fila de usuarios legítimos más abajo) |
| Laberinto canary + espejismo de señuelos | Calidad de la señal y seguridad | Corrección y accesibilidad verificadas (Playwright + axe, **0 infracciones**), límites estrictos aplicados (240 accesos / 10 min / IP, 10,000 páginas/día, luego HTTP 404). Son capas de detección - no afirmamos ningún porcentaje de bloqueo de extracción para ellas |
| Límite compartido de cohorte (cohorte declarada + manifiesto de nivel de límite) | ¿Funciona de extremo a extremo la ruta legal de límite estricto? (ronda clásica de v2.5.0; límite declarado de 600 registros) | Activado al momento de la declaración y probado de nuevo: la unión de la cohorte declarada se detuvo en **exactamente 600 registros distintos** en ambas ejecuciones (el primer intento condicionado por cruce se excedió hasta 2,700), los 18 recorredores declarados bloqueados, **710-714 rechazos por límite** por ejecución y 0 registros servidos más allá del límite, los controles en la misma instancia sin afectar (cumplimiento 1,200/1,200, cero fricción). Las cohortes declaradas sin manifiesto de nivel de límite no activan nada; las cohortes inferidas mantienen la ruta condicionada por cruce; ver [Limitations](docs/LIMITATIONS.md) |
| Pila completa frente a atacante adaptativo | El atacante reparte deliberadamente el trabajo entre 18 identidades y diluye su patrón (ronda clásica de v2.5.0) | La extracción aún se completó mediante rotación - pero la fase 1 (18 identidades) fue contenida en el **78%** tras ~18 minutos de fricción de verificación adicional, expiraciones de sesión y reducciones suaves de presupuesto, con cada identidad de la fase 1 dentro del conjunto marcado/consecuenciado, y terminar tomó **25 identidades y ~19 minutos** en total. La fase 1 del equipo de recorrido de ID fue contenida en el **90.0%** - exactamente 500 registros por recorredor, el piso suave para cohortes inferidas - con los 18 recorredores limitados y 324 interrupciones de sesión en la fase 1 (antes de esta ronda: 91.0%, 224 interrupciones, 2 recorredores por encima del piso). La rotación sigue siendo el límite principal conocido de la pila; ver [Limitations](docs/LIMITATIONS.md) |
| Usuarios legítimos | Equipo de cumplimiento declarado, revisión sistemática no declarada, usuarios corteses, cohortes con IP compartida (NAT) (ronda clásica de v2.5.0, remedido) | Cumplimiento declarado (protegido): **1,200/1,200 registros, cero fricción**. Revisión sistemática no declarada: marcada y con fricción (verificación adicional + reducción suave) pero **cero pérdida de datos - 1,200/1,200 servidos**. Usuarios corteses y grupos NAT: **cero consecuencias** - incluidos los usuarios corteses que siguieron navegando a mitad de sesión dentro de un grupo mientras era marcado (orientación por contribución, novedad de 2.5.0) |
| Presupuesto de acciones frente a grupo de abuso de funciones (laboratorio) | Grupo con scripts que reparte acciones costosas entre 24 identidades (ronda clásica de funciones de v2.6.0, lado protegido, medición de laboratorio) | Base (sin protección): **80/80 operaciones completadas en 241 ms, 0 interrupciones**. Con protección, tras la ronda de corrección: **16/80 completadas (20.0%)**, el máximo de objetivos distintos por identidad se mantuvo en **500**, y la cobertura de fricción medida por inscripción fue de **24/24** identidades (el contador de unión de marcas leyó 14/24 - la inscripción en el momento del intento detiene a los que se incorporan antes de que generen las observaciones que ese contador cuenta; ambas cifras se informan en el análisis detallado). Economía del atacante en la misma ronda: 220 intentos, 108 interrupciones, 96 respuestas de límite de velocidad HTTP 429, tiempo total 480,445 ms (se alcanzó el tope del controlador) |
| Usuarios legítimos del lado de funciones (laboratorio) | Equipo declarado, equipos no declarados y usuarios comunes bajo la capa de acciones (ronda clásica de funciones de v2.6.0, lado protegido, medición de laboratorio) | Equipo declarado de 6: **40/40 operaciones, 0 fricción, 0 inscritos**. Equipo no declarado de 6: **40/40, 0 trabajo perdido, ninguna denegación estricta**. Equipo no declarado de 8: a los 15 minutos, **20/40 completadas**, con 3,205 intentos y 3,185 eventos de fricción - todos en el nivel de verificación adicional + piso suave, **0 denegaciones estrictas**; el trabajo nunca se rechaza de plano, fluye a la velocidad limitada publicada. Usuarios comunes (8): **48/48 éxitos en el primer intento, 0 consecuencias** |
| Acciones canary (laboratorio) | Objetivos de acción falsos registrados (una promoción / porción de exportación que ninguna interfaz real emite) tocados por una identidad atacante (ronda clásica de funciones de v2.6.0, lado protegido, medición de laboratorio) | Tocar el objetivo canary (porción 40) contaminó solo a quien lo tocó, lo vinculó al grupo marcado mediante `taintedMembers` y lo inscribió en verificación adicional sobre evidencia directa; el observador en la misma celda midió **0 contaminación, 0 inscripciones, 0 anulaciones**. La ronda 1 de esta celda no superó su subcomprobación del observador por la materialidad de costo bruto; la materialidad basada en la contribución de la ronda de corrección superó las cuatro subcomprobaciones - ver el análisis detallado |

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

`npm run check` compila, ejecuta **338 pruebas automatizadas** (336 superadas, 2 vectores RSA-PSS omitidos) y realiza comprobaciones estáticas. Escanea el directorio público de compilación antes del despliegue con `node scripts/run-audit.cjs /path/to/dist` o `python3 scripts/verify-build.py /path/to/dist`.

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
