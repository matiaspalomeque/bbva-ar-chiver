#!/usr/bin/env bun
/**
 * BBVA Argentina – Descarga de Resúmenes en PDF
 * =================================================
 * Descarga todos los resúmenes (estados de cuenta) disponibles en PDF
 * desde el home banking de BBVA Argentina.
 *
 * CONFIGURACIÓN
 * -------------
 * 1. Instalá Bun:         https://bun.sh
 * 2. Instalá dependencias: bun install
 *    (o manualmente):      bun add playwright && bunx playwright install firefox
 * 3. Creá un archivo .env con tus credenciales (ver .env.example)
 *
 * USO
 * ---
 *   bun bbva-ar-chiver.ts                  # Descarga en ./bbva-resumenes/
 *   BBVA_OUT_DIR=~/Documents bun bbva-ar-chiver.ts
 *   HEADLESS=false bun bbva-ar-chiver.ts   # Ver el navegador en acción
 *
 * RE-EJECUCIÓN
 * ------------
 * Los archivos ya descargados se omiten automáticamente, así que podés
 * volver a ejecutar el script para descargar nuevos resúmenes sin problema.
 */

import { firefox, type Page } from "playwright";
import { mkdir, writeFile, access } from "fs/promises";
import { join } from "path";

function require_env(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`❌  Falta la variable de entorno: ${name}`);
    console.error(`    Creá un archivo .env o exportala antes de ejecutar.`);
    process.exit(1);
  }
  return val;
}

const CONFIG = {
  dni: require_env("BBVA_DNI"),
  usuario: require_env("BBVA_USUARIO"),
  clave: require_env("BBVA_CLAVE"),
  outDir: process.env.BBVA_OUT_DIR ?? "./bbva-resumenes",
  headless: process.env.HEADLESS !== "false",
};

const TIMINGS = {
  slowMo:             234,   // retardo global del navegador aplicado a cada acción
  typeDelay:           80,   // ms por tecla al completar campos de formulario
  clickDelay:          90,   // ms por clic en interacciones con la interfaz
  postLoginWait:    2_000,   // tiempo de asentamiento tras la redirección post-login
  loginTimeout:    10_000,   // timeout para waitForURL / waitForLoadState tras login
  summariesTimeout: 4_000,   // timeout para waitForSelector de bbva-card-resumen
  downloadDelay:    1_500,   // pausa entre descargas consecutivas de PDF
} as const;

const LOGIN_URL = "https://online.bbva.com.ar/fnetcore/login/index.html";

interface Statement {
  detalle: string;
  fechaCierre: string;
  reporte: string;
}

let interrupted = false;

async function main() {
  await mkdir(CONFIG.outDir, { recursive: true });

  const browser = await firefox.launch({
    headless: CONFIG.headless,
    slowMo: TIMINGS.slowMo,
  });

  process.once("SIGINT", async () => {
    interrupted = true;
    console.log("\n\n⚠️   Interrupción detectada, cerrando el navegador…");
    await browser.close();
  });

  const ctx = await browser.newContext({
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  try {
    await login(page);
    await waitForLandingPage(page);
    await goToSummaries(page);
    const stmts = await getAllStatements(page);
    console.log(`\n📄  Se encontraron ${stmts.length} resúmenes\n`);
    await downloadAll(page, stmts);
  } finally {
    if (!interrupted) await browser.close();
  }
}

async function jitterMouse(page: Page, steps = 3) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(
      Math.floor(Math.random() * 1280),
      Math.floor(Math.random() * 800),
    );
    await page.waitForTimeout(60 + Math.floor(Math.random() * 140));
  }
}

async function login(page: Page) {
  console.log("🔐  Iniciando sesión…");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  await jitterMouse(page, 4);

  const docNumberField = page.getByRole("spinbutton", { name: "Número de documento" });
  await docNumberField.pressSequentially(CONFIG.dni, { delay: TIMINGS.typeDelay });
  await jitterMouse(page);

  const usernameField = page.getByRole('textbox', { name: 'Usuario' });
  await usernameField.pressSequentially(CONFIG.usuario, { delay: TIMINGS.typeDelay });
  await jitterMouse(page);

  const passwordField = page.getByRole('textbox', { name: 'Clave' });
  await passwordField.pressSequentially(CONFIG.clave, { delay: TIMINGS.typeDelay });
  await jitterMouse(page, 2);

  const loginButton = page.getByRole('button', { name: 'Ingresar' });
  await loginButton.click({ delay: TIMINGS.clickDelay });

  console.log("✅  Sesión iniciada");
}

async function dismissModalIfExists(page: Page) {
  const modal = page.locator('bbva-help-modal-sph[visible]');
  try {
    await modal.waitFor({ state: 'visible', timeout: 1500 });
  } catch {
    return;
  }
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
}

async function waitForLandingPage(page: Page) {
  console.log("🏠  Esperando página principal…");
  await page.waitForURL((url) => url.toString().includes("globalposition"));
  await page.waitForLoadState("load", { timeout: TIMINGS.loginTimeout });

  await dismissModalIfExists(page);
  console.log("✅  Página principal cargada");
}

async function goToSummaries(page: Page) {
  console.log("📂  Navegando a resúmenes…");
  const summariesAndCardsButton = page.getByRole('button', { name: 'Resúmenes y tarjetas', exact: true });
  await summariesAndCardsButton.click({ delay: TIMINGS.clickDelay });

  await dismissModalIfExists(page);

  const summariesLink = page.getByRole('link', { name: 'Resúmenes', exact: true });
  await summariesLink.click({ delay: TIMINGS.clickDelay });

  await page.waitForSelector("bbva-card-resumen", { timeout: TIMINGS.summariesTimeout });

  console.log("✅  Página de resúmenes cargada");
}

async function getAllStatements(page: Page): Promise<Statement[]> {
  console.log("🔍  Obteniendo lista de resúmenes…");
  return page.evaluate(() => {
    const ng = (window as any).angular;
    const root = ng.element(document).injector().get("$rootScope");

    let ctrl: any = null;
    (function walk(s: any, depth: number) {
      if (depth > 12 || ctrl) return;
      if (s.sumCtrl) { ctrl = s.sumCtrl; return; }
      if (s.$$childHead) walk(s.$$childHead, depth + 1);
      if (s.$$nextSibling) walk(s.$$nextSibling, depth + 1);
    })(root, 0);

    if (!ctrl) throw new Error("No se encontró sumCtrl — es posible que la página no haya cargado completamente");

    const { cardSummaries = [], pastSummaries = [] } = ctrl.operations.data;

    return [...cardSummaries, ...pastSummaries].map((s: any) => ({
      detalle: s.detalle as string,
      fechaCierre: s.fechaCierre as string,
      reporte: s.reporte as string,
    }));
  });
}

async function downloadAll(page: Page, stmts: Statement[]) {
  console.log("⬇️   Iniciando descarga de resúmenes…");
  const errors: string[] = [];
  let skipped = 0;

  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    const [dd, MM, yyyy] = s.fechaCierre.split("/");
    const date = `${yyyy}-${MM}-${dd}`;
    const title = s.detalle.replace(/[/\s,]+/g, "_");
    const filename = `BBVA_${title}_${date}.pdf`;
    const filepath = join(CONFIG.outDir, filename);
    const tag = `[${i + 1}/${stmts.length}]`;

    // Omitir archivos ya descargados
    const exists = await access(filepath).then(() => true).catch(() => false);
    if (exists) {
      console.log(`  ⏭   ${tag}  Ya existe: ${filename}`);
      skipped++;
      continue;
    }

    if (interrupted) break;

    try {
      // Usamos el $http de Angular para que los headers de CSRF/auth se incluyan automáticamente
      const b64 = await page.evaluate(async (reporte: string) => {
        const $http = (window as any).angular
          .element(document)
          .injector()
          .get("$http");

        const resp = await $http({
          method: "POST",
          url: "servicios/cliente/extractos/getPdf",
          data: { reporte },
          responseType: "arraybuffer",
        });

        // Convertimos ArrayBuffer → base64 para transferirlo de vuelta a Node/Bun
        const bytes = new Uint8Array(resp.data as ArrayBuffer);
        let bin = "";
        bytes.forEach((b) => { bin += String.fromCharCode(b); });
        return btoa(bin);
      }, s.reporte);

      const buf = Buffer.from(b64, "base64");
      await writeFile(filepath, buf);
      console.log(`  ✅  ${tag}  ${filename}  (${(buf.length / 1024).toFixed(0)} KB)`);

    } catch (err: any) {
      if (interrupted) break;
      errors.push(filename);
      console.error(`  ❌  ${tag}  FALLÓ: ${filename}`);
      console.error(`        ${err?.message ?? String(err)}`);
    }

    if (interrupted) break;
    await page.waitForTimeout(TIMINGS.downloadDelay);
  }

  const downloaded = stmts.length - errors.length - skipped;
  console.log(`
________________________________________
  ✅  Descargados      : ${downloaded}
  ⏭   Omitidos        : ${skipped}  (ya existían)
  ❌  Fallidos         : ${errors.length}
  📁  Carpeta de destino: ${CONFIG.outDir}
________________________________________`);

  if (errors.length) {
    console.log("\nArchivos con error:");
    errors.forEach((e) => console.log(`  • ${e}`));
  }
}

main().catch((err) => {
  if (interrupted) process.exit(0);
  console.error("\n💥  Error fatal:", err);
  process.exit(1);
});
