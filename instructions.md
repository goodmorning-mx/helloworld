# helloworld · instrucciones para agentes

Este archivo es parte del contrato operativo de un producto administrado por
GoodMorning Factory. La sección entre los marcadores `FACTORY MANAGED` es
generada por Factory desde el manifiesto versionado y puede cambiar cuando
cambia el contrato de la plataforma.

<!-- GOODMORNING FACTORY: MANAGED START -->
## Contexto administrado · contrato v1

GoodMorning Factory administra este producto. El repositorio del producto es la fuente de verdad de la aplicación; Factory es la fuente de verdad de su provisionamiento y operación.

- Producto: `helloworld`
- Repositorio: `goodmorning-mx/helloworld`
- Topología: `resources-v3`
- Rama de desarrollo integrada: `dev`
- DEV frontend: `dev.helloworld.goodmorning.mx`
- PROD esperado: `https://helloworld.goodmorning.mx`

### Cómo trabajar

1. Inspecciona primero el estado real del repositorio y lee `AGENTS.md`, `CLAUDE.md`, README, contratos y documentación aplicables.
2. Trabaja desde una rama de feature/fix/chore creada desde `dev`; integra mediante pull request hacia `dev`.
3. Mantén `main` como producción. La promoción a producción usa el flujo de release de Factory y no se hace con pushes directos.
4. Preserva compatibilidad, migraciones, autenticación, APIs, módulos core, healthchecks, datos y despliegues existentes.
5. Verifica con los comandos del repositorio y con los flujos reales de CI/DEV. No inventes comportamiento de GitHub, Coolify ni secretos.
6. Completa el goal de punta a punta y reporta archivos, validaciones, riesgos, impacto de configuración y rollback.

### Operación DEV/PROD

- DEV sigue `dev`, usa recursos aislados y auto-deploy de Coolify cuando el contrato lo declara.
- PROD sigue `main`, requiere promoción explícita, validación previa y backup verificado cuando hay base de datos.
- Las aplicaciones se observan por sus healthchecks; una configuración no verificada debe detener la reconciliación.
- PostgreSQL es privado. Las URLs de base de datos, secretos administrados y valores generados se inyectan en runtime; nunca se escriben en este archivo.
- Las bases persistentes conservan backups externos cuando el manifiesto los declara.

### Arquitectura y recursos

#### Aplicaciones

- `api` · rol `api` · puerto `8000` · healthcheck `/health` · dominio `https://api.dev.helloworld.goodmorning.mx` · auto-deploy `True`
- `frontend` · rol `frontend` · puerto `80` · healthcheck `/` · dominio `https://dev.helloworld.goodmorning.mx` · auto-deploy `True`
  - Variables declaradas (sin valores): `VITE_API_URL` [literal]

#### Bases de datos

- `postgres` · versión `16` · privado `True` · persistencia/backups declarados en el manifiesto

#### Módulos core y servicios

- `gm-pwa` v`0.1.4` · tipo `frontend` · modo seleccionado `embedded` · modos permitidos: `embedded`
- `gm-auth` v`0.1.4` · tipo `full-stack` · modo seleccionado `embedded` · modos permitidos: `embedded`, `service`
  - Recurso `postgres` · clase `postgresql` · owner `gm-auth` · shared `True`
  - Bindings (sin valores): `DATABASE_URL` [database_url, driver=psycopg]
- `gm-mcp` v`0.3.1` · tipo `backend` · modo seleccionado `embedded` · modos permitidos: `embedded`, `gateway`
- `gm-billing` v`0.1.0` · tipo `full-stack` · modo seleccionado `embedded` · modos permitidos: `embedded`, `service`
- `gm-agent` v`0.1.5` · tipo `full-stack` · modo seleccionado `embedded` · modos permitidos: `embedded`, `service`, `gateway`

### Validación y Definition of Done

- Ejecutar los checks documentados del producto: typecheck/lint, tests unitarios e integración, build, `docker compose config` o builds de servicios cuando apliquen.
- Validar healthchecks y smoke checks de DEV después de cambios de despliegue; no afirmar que un entorno está funcionando sin evidencia.
- Confirmar que no se agregaron secretos, tokens, credenciales, UUIDs privados ni identificadores de infraestructura.
- Confirmar que las capacidades existentes y las migraciones siguen siendo compatibles.
- Documentar cualquier check omitido, riesgo restante y procedimiento de rollback.

### Límites importantes

No modifiques contratos de Resources V3, bindings, managed secrets, ownership, healthchecks, auto-deploy, backups o migraciones sin entender su efecto en DEV y PROD. Prefiere cambiar el manifiesto y el reconciliador versionado antes que realizar pasos manuales en Coolify.
<!-- GOODMORNING FACTORY: MANAGED END -->

<!-- GOODMORNING PRODUCT: CUSTOM START -->
Agrega aquí instrucciones específicas del producto. Esta sección no es administrada por Factory.
<!-- GOODMORNING PRODUCT: CUSTOM END -->
