<p align="center">
  <img src="logo.svg" alt="antiRea logo" width="104">
</p>

<h1 align="center">antiRea</h1>

<p align="center">
  <strong>Build it. Ship it. Keep it yours.</strong>
</p>

<p align="center">
  antiRea es una librería de TypeScript del lado del servidor que mide
  el acceso al conjunto de datos por identidad y marca el abuso
  coordinado de bots: equipos de extracción masiva, grupos que actúan
  por horarios, ocupación de asientos. Es solo consultiva: marca, y
  tú decides.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/@dannyphan190/anti-rea"><img src="https://img.shields.io/npm/v/@dannyphan190/anti-rea.svg" alt="npm version"></a>
  <a href="https://github.com/dankezo/antiRea/actions/workflows/ci.yml"><img src="https://github.com/dankezo/antiRea/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="tests/"><img src="https://img.shields.io/badge/tests-1683%20total-informational" alt="tests: 1683 total"></a>
</p>

<p align="center">
  <a href="https://antirea.dannyphan.me">Website</a> -
  <a href="docs/THREAT_MODEL_REA.md">Modelo de amenazas</a> -
  <a href="docs/LIMITATIONS.md">Limitaciones</a> -
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <a href="README.md">English</a> - <a href="README.vi.md">Tiếng Việt</a> - <a href="README.zh.md">中文</a> - Español
</p>

---

## El problema, en 30 segundos

Las herramientas de clonación pueden observar las páginas, los
paquetes y el tráfico de tu aplicación, y reconstruir lo que vieron.
No puedes ocultar el código que un navegador ya recibió, así que
antiRea defiende el otro lado: los datos en sí.

**Sin protección.** Cualquiera con una cuenta puede llevarse tus
datos a casa. En nuestras pruebas, una sola cuenta se llevó el
conjunto de datos completo de 10,000 registros en menos de 200
solicitudes. En silencio. Nada inusual en los registros.

**Con protección.** Los usuarios reales no notan nada.
Cada identidad solo puede recibir una porción limitada: el 20% del
conjunto de datos en nuestra configuración de prueba, así que copiar
deja de ser una exportación y se convierte en un problema de
identidad.
Si el trabajo se reparte entre muchas cuentas, el detector de grupos
marca la coordinación.

- La ejecución que se llevó todo con 1 cuenta fue **detenida en el 5%**.
- Un equipo con scripts que insistió en terminar necesitó **25
  identidades y unos 19 minutos**, y fue marcado en el camino.

> Sin protección, tus datos salen completos, gratis e invisibles.
> Con protección, salen en porciones, con un costo y con registro.

Cifras completas: [Resultados medidos](#funciona-resultados-medidos).

## Instalación

```bash
npm install @dannyphan190/anti-rea
```

Node.js 20+. Sin dependencias en tiempo de ejecución.
También disponible en [GitHub Release](https://github.com/dankezo/antiRea/releases).

## Inicio rápido

Las cuotas de solicitudes limitan la velocidad. Un presupuesto de
registros limita cuánto del conjunto de datos puede recibir una
identidad en total, por muy educadamente que lo pida.

```ts
import { createRecordBudget, createHerdDetector } from "@dannyphan190/anti-rea";

// Una identidad recibe como máximo 2,000 registros distintos por día.
const budget = createRecordBudget({ maxDistinctPerWindow: 2_000 });
const herd = createHerdDetector({
  onFlag: snap => { /* snap.band: "budget_cut_supported" | "graduated_only" */ },
});

// Comprueba antes de que se ejecute el manejador:
if (!budget.check("account:123", 1).allowed) { /* devolver 429 */ }

// Después registra lo que la respuesta realmente sirvió:
budget.consume("account:123", recordIdsServed);
herd.observe({ type: "list", identity: "account:123", ip: serverSeenIp, recordIds: recordIdsServed });
```

Usa la misma cadena de identidad (`account:<id>`) en ambos, y una
marca de grupo puede alimentar directamente un recorte de presupuesto
mediante `applyHerdLadder()`.

## Qué incluye

Cuatro grupos. Empieza por arriba; cada capa es independiente.

| Grupo | Qué hace, en palabras simples | Piezas principales | Límite honesto |
|---|---|---|---|
| **Meter** | Limita cuántos datos puede recibir una identidad en total, y a qué velocidad | Presupuesto de registros (`createRecordBudget`), guardián de cuotas y paginación (`createQuotaGuard`), exportaciones con precio (`createExportGuard`), cursores de sesión (`mintCursor` / `verifyCursor`), puntuación de flujo (`createFlowScorer`) | Los atacantes pueden rotar identidades: combínalo con un costo real de registro por tu parte |
| **Ownership** | Detecta a una identidad barriendo objetos de otras personas (el recorrido BOLA/IDOR: ids secuenciales, ids aleatorios o una dispersión lenta durante horas) y lo reporta con evidencia | Sonda de propiedad (`createOwnershipProbe`): proporción de propietarios distintos por identidad en ventanas móviles (1 h por defecto, añade 6 h para barridos lentos), rutas públicas exentas, estado incremental con lecturas de veredicto O(1); solo advisory | Una marca es una forma, no una prueba: la autorización sigue siendo tu trabajo, y un barrido bajo los suelos o concentrado en pocos propietarios queda fuera de alcance |
| **Watch** | Detecta la coordinación: muchas identidades cubriendo tu conjunto de datos en silencio, sondeando señuelos u ocupando una sala | Detector de grupos (`createHerdDetector` + `applyHerdLadder`), señales de fase (`createHerdPhaseSignal`, `createActivityPhaseSignal`), guardián de salas (`createRoomGuard`), trampas canary y señuelos (`handleCanaryTrapRequest`, `createCanaryMaze`, `createDecoyMirage`), telemetría de automatización (`detectAutomationSignals`), higiene de source maps (`verify-build.py` / `run-audit.cjs`), regla de rango por volumen (`applyVolumeRankRule`), calibración de mezcla empírica (`selectEmpMixThreshold`), rasgos de temporización de sesión (`computeHoldTypeFeatures` / `createHoldTypeScorer`), señal de ocupación mínima temprana (`createOccupancyEarlyMinimalSignal`) | Detectar no es aplicar: los grupos de cobertura fina reciben una respuesta gradual, y un grupo adaptativo fue marcado pero aun así terminó |
| **Prove** | Fija lo que significa un veredicto: qué configuración lo produjo, quién firmó realmente, qué puede fundamentar una consecuencia | Procedencia de configuración (`createConfigProvenance`), verificación de Web Bot Auth (`createWebBotAuthVerifier`), pruebas de step-up (`issueStepUpProof`, `createStepUpProofVerifier`), modelado de la consecuencia del step-up (`createStepUp402Responder`), roles de evidencia (`evidentiaryRoleOf`, `auditEvidencePack`, `decorateSignalResult`) | Una firma verificada es identidad, no autorización: tus controles de acceso se quedan exactamente como están |
| **Trace** | Ayudas opcionales del lado del cliente para filtraciones y repeticiones | Sobres ligados al contexto (`encryptPayload` / `decryptPayload`, `createInMemoryReplayGuard`), marca de agua forense (`mountForensicWatermark`), registro de declaraciones de preferencia (`createDeclarationLog`) | Trazabilidad, no control de acceso: las capas superpuestas pueden recortarse, y el navegador guarda su propio contexto |

**Orden recomendado:** primero el guardián de cuotas (ver abajo),
después el presupuesto de registros y luego la detección de grupos.

## ¿Funciona? Resultados medidos

**Método, en breve.** Probamos contra **Ledgerly**, un SaaS sintético
con 10,000 registros tras 120 cuentas, ejecutado dos veces: sin
protección, y la misma aplicación con antiRea conectado. Las
ejecuciones de ataque las conducen REA 6.8.0 (`rea-agents`) y agentes
de propósito general que siguen el flujo de clonación estándar; las
ejecuciones de usuarios educados miden el costo para el tráfico
legítimo. Un benchmark independiente se publicó en el
[issue #1](https://github.com/dankezo/antiRea/issues/1): la mayoría de
las afirmaciones se sostuvieron, y las brechas que encontró están
corregidas y en el changelog.
Método completo y tabla por capa: [docs/EVIDENCE.es.md](docs/EVIDENCE.es.md).

| Capa | Resultado principal |
|---|---|
| Sin protección (línea base) | El conjunto de datos completo de 10,000 registros sale en **160-193 solicitudes** |
| Presupuesto de registros | Una identidad queda limitada a exactamente el **20%** del conjunto de datos |
| Detector de grupos + evidencia CUSUM | La rotación de identidades estilo REA se detuvo en el **5%**; un equipo adaptativo necesitó **25 identidades y ~19 minutos** |
| Techo de cohorte declarada | La unión de la cohorte se detuvo en exactamente **600 registros**, cero servidos por encima del techo |
| Usuarios legítimos | Equipo declarado **1,200/1,200 sin fricción**; usuarios educados, cero consecuencias |
| Presupuesto de acciones (lab) | El grupo de abuso de funciones completó **16/80 operaciones (20%)**; usuarios normales **48/48**, cero consecuencias |
| Señales consultivas (lab) | Cinco señales de forma lenta: **0-1.67%** de marcas falsas sobre tráfico legítimo: cifras por señal en la tabla completa |

**Lo que esto suma.** La clonación casual de un solo intento
desaparece. La extracción masiva se convierte en un problema de
identidad: cada porción extra cuesta otra cuenta y más visibilidad.
No detiene a un reconstructor decidido y con recursos, y el precio
real de una identidad (fricción de registro, cuentas verificadas,
pago) lo fijas tú, por eso los presupuestos son por identidad y las
marcas de grupo distinguen "recortar el presupuesto" de "aumentar la
vigilancia".

## También habla MCP

antiRea incluye un servidor MCP oficial para agentes de IA:
[`@dannyphan190/anti-rea-mcp`](https://www.npmjs.com/package/@dannyphan190/anti-rea-mcp)
([código fuente](https://github.com/dankezo/anti-rea-mcp)), construido
sobre el `@modelcontextprotocol/sdk` oficial, que habla MCP por stdio.

Expone los ocho tipos de señales consultivas de la librería como seis
herramientas (`list_signals`, `create_signal`, `observe`,
`observe_reference`, `evaluate`, `close_signal`), para que un agente
pueda abrir una sesión de señal, alimentarla con eventos y leer el
veredicto.

```json
{
  "mcpServers": {
    "anti-rea": {
      "command": "npx",
      "args": ["-y", "@dannyphan190/anti-rea-mcp"]
    }
  }
}
```

Es un canal de evaluación y demostración. La protección en producción
sigue perteneciendo al proceso, dentro de tu propia aplicación.

## Última versión

### v3.2.0 - Superficie polimorfa por host: anti-reverse con caducidad

Las rutas trampa canary empaquetadas eran idénticas en cada despliegue: leer el SDK una vez era conocer las trampas de todos los sitios para siempre. Esta versión convierte la superficie de cada despliegue en una forma distinta que rota semanalmente. Todo es opt-in y advisory; ningún valor por defecto cambia.

- **Superficie polimorfa (`derivePolymorphCanaryPaths`, `derivePolymorphSurface`):** derive rutas canary de aspecto natural desde una semilla del host y una época semanal (determinista, solo SHA-256, sin dependencias nuevas) y páselas a la maquinaria canary que ya usa. Las rutas de la época anterior vuelven como trampas retiradas, solo detectores: un toque en una de ellas significa información vieja o robada.
- **Integridad de variante (`buildVariantManifest`, `verifyVariantManifest`):** manifiestos SHA-256 sobre los archivos de una variante. La verificación nunca lanza y nunca bloquea; devuelve un objeto señal con el motivo de discrepancia por archivo para registrar o alertar.
- **Generador polimorfo (`tools/polymorph/`):** herramienta de build que ofusca los cuatro módulos de superficie (cursor, canary-echo, fake-endpoints, trap-paths) con su semilla, incrusta una marca de agua inerte y extraíble con la huella del host para rastrear filtraciones, añade código muerto señuelo plausible y escribe el manifiesto de superficie. javascript-obfuscator es solo una herramienta de build opcional para el generador; el runtime del SDK sigue con cero dependencias.
- **Medido (prototipo de laboratorio, 2026-11-19):** los módulos de superficie transformados cuestan alrededor de 1,6x de CPU en la ruta del cursor y +11,7% de tamaño en los cuatro módulos; en una variante generada por el propio generador de esta versión, los 7 archivos de test de superficie pasan 72/72, un fuzz diferencial de cursor de 2.000 casos es idéntico byte a byte a la dist limpia, y los tokens echo se verifican cruzados 500/500 en ambas direcciones. Aún no se ha ejecutado una prueba real de lectura por un agente, así que no se afirma cuánto más difícil se vuelve el análisis automatizado.

1683 pruebas: 1681 superadas, ningún fallo, 2 omitidas.

Versiones anteriores: consulta el [Changelog](CHANGELOG.md).

## Primer paso: el guardián de cuotas

Cuotas del lado del servidor y límites de paginación, aplicados por
cuenta, clave de API e IP. Devuelve HTTP `429` con `Retry-After` y
registra eventos estructurados para los operadores.

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
    accountId: req.headers.get("x-verified-account") ?? undefined, // de la autenticación de tu servidor
    apiKeyId: req.headers.get("x-verified-key-id") ?? undefined,
    tier: "free",
  }),
  onQuotaExceeded: event => {
    console.warn("[quota-exceeded]", event);
  },
}));
```

### Más patrones

- **Endpoints canary**: rutas trampa que registran sondeos anómalos,
  con canonicalización de rutas para que las variantes no se cuelen.
  Ejemplo ejecutable: [examples/node-canary-server.cjs](examples/node-canary-server.cjs).
- **Agentes firmados**: verifica firmas Web Bot Auth (RFC 9421) y
  aplica la política de cuotas sobre una identidad estable. Demo
  completa ejecutable: [examples/web-bot-auth-verify.cjs](examples/web-bot-auth-verify.cjs).
- **Python / FastAPI**: el guardián de cuotas portado con los mismos
  niveles, la misma semántica de `429` y los mismos límites de
  paginación, sujeto al mismo contrato de pruebas:
  [examples/python-fastapi](examples/python-fastapi).
- **Techos de cohorte compartidos y el motor de evidencia CUSUM**:
  reserva transaccional sobre toda una cohorte declarada, con cohortes
  protegidas cuya telemetría se acumula pero nunca genera una
  consecuencia: semántica en [docs/LIMITATIONS.md](docs/LIMITATIONS.md).
- **Marca de agua y sobres**: ver el grupo Trace arriba; nunca incrustes
  el correo, la IP o el ID de usuario sin procesar de una persona en
  los píxeles de la marca de agua.

## Límites honestos

- **No puede** ocultar el código entregado a un navegador, ni impedir
  que alguien inspeccione lo que su propio navegador descargó.
- **No puede** detener a un reconstructor decidido y con recursos. En
  su lugar, hace que la copia masiva sea lenta, costosa y visible.
- Las tablas integradas del motor de evidencia se ajustaron sobre
  trazas de laboratorio, no sobre una población real de usuarios, y
  llevan la etiqueta `uncalibrated: true` dondequiera que se mencionan.
  Ver el piloto de calibración más abajo.
- Las piezas del lado del cliente son ayudas de trazabilidad, no
  control de acceso.
- Sin trucos de bloqueo de bots del lado del cliente y sin inyecciones
  de prompts: no se sostienen, y no son controles éticos.
  Ver [docs/REFERENCES.md](docs/REFERENCES.md).

Lista completa: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Reproducir las cifras

El repositorio incluye un entorno de Playwright que ejecuta un SaaS
sintético (**Northstar**: panel, búsqueda de clientes, creación de
clientes potenciales, exportación CSV, vistas de gráficos) en modos
base (`:4173`) y protegido (`:4174`), en Chromium, Firefox y WebKit.

```bash
npm install
npm run build && npm run benchmark:build-sdk
python -m pip install playwright
python -m playwright install chromium firefox webkit
python benchmark/run_all.py --browsers chromium,firefox,webkit --iterations 5
```

Trabajar en el propio repositorio: `npm run check` compila, ejecuta
**1683 pruebas automatizadas** (1681 superadas, ningún fallo, 2 omitidas) y realiza comprobaciones estáticas. Escanea una compilación
pública antes de desplegar con `node scripts/run-audit.cjs /path/to/dist`
o `python3 scripts/verify-build.py /path/to/dist`.

## Ayuda a calibrarlo

Lo único que este proyecto no puede generar por sí mismo es tráfico
real. Si ejecutas antiRea (o lo estás evaluando), ejecuta el tripwire
CUSUM en `mode: "observe"` (los cruces se registran, nada se restringe)
y comparte las **instantáneas agregadas anonimizadas** que emite:
tamaños de cohorte, puntuaciones, conteos de registros en unión.

Sin datos de usuario sin procesar, sin contenidos de registros, sin
identificadores. Revisa y depura una instantánea antes de enviarla; si
un campo parece identificativo, déjalo fuera y dilo. El primer
conjunto real de instantáneas es la forma de quitar la etiqueta
`uncalibrated`.

¿Te interesa, o quieres primero el formato de instantánea?
Escribe a **dannyphan190@gmail.com**.

## Documentación

- [Modelo de amenazas](docs/THREAT_MODEL_REA.md): qué asume antiRea sobre los atacantes
- [Limitaciones](docs/LIMITATIONS.md): lo que no hace
- [Evidencia](docs/EVIDENCE.es.md): resultados medidos completos y método
- [Notas legales y de privacidad](docs/LEGAL_PRIVACY.md)
- Análisis detallados: [v2.9.0](docs/v2.9.0-deep-dive.es.md) - [v2.8.1](docs/v2.8.1-deep-dive.es.md) - [v2.8.0](docs/v2.8.0-deep-dive.es.md)
- [v2.9.1 deep dive](docs/v2.9.1-deep-dive.es.md)
- [v2.9.2 deep dive](docs/v2.9.2-deep-dive.es.md)
- [Changelog](CHANGELOG.md)

## Contribuciones y seguridad

Lee [CONTRIBUTING.md](.github/CONTRIBUTING.md) y
[SECURITY.md](.github/SECURITY.md) antes de abrir un pull request
o un informe de vulnerabilidad.

**Financiación del proyecto:** [Apoya al mantenedor](https://www.paypal.com/paypalme/dannyphan190)
(opcional; nunca necesario para usarlo).

<p>
  Featured on
  <a href="https://launchnest.io/p/antirea" target="_blank"><img src="https://launchnest.io/badge/antirea.svg?variant=featured" alt="antiRea on LaunchNest" width="160" height="40" /></a>
</p>
