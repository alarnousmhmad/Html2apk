import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import AdmZip from "adm-zip";
import { nanoid } from "nanoid";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const OUTPUT_DIR = path.join(DATA_DIR, "outputs");
const WORK_DIR = path.join(DATA_DIR, "work");
const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_EXPANDED = 60 * 1024 * 1024;
const MAX_ENTRIES = 1500;
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_BUILDS || 1));
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

const jobs = new Map();
const queue = [];
let activeBuilds = 0;

await Promise.all([UPLOAD_DIR, OUTPUT_DIR, WORK_DIR].map(p => fs.mkdir(p, { recursive: true })));

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: "32kb" }));
app.use("/api", rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".html", ".htm", ".zip"].includes(ext)) return cb(new Error("ارفع ملف HTML أو ZIP فقط."));
    cb(null, true);
  }
});

function cleanAppName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 40 || /[\u0000-\u001f<>]/.test(name)) {
    throw new Error("اسم التطبيق مطلوب ويجب ألا يتجاوز 40 حرفاً.");
  }
  return name;
}

function cleanPackageId(value) {
  const id = String(value || "").trim();
  if (id.length > 180 || !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,8}$/.test(id)) {
    throw new Error("معرّف الحزمة غير صالح. مثال: com.example.myapp");
  }
  return id;
}

function safeExtract(zip, destination) {
  const entries = zip.getEntries();
  if (!entries.length || entries.length > MAX_ENTRIES) throw new Error("عدد ملفات ZIP غير مسموح.");
  let expanded = 0;

  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, "/");
    if (name.startsWith("/") || /^[a-zA-Z]:/.test(name) || name.split("/").some(p => p === "..")) {
      throw new Error("ملف ZIP يحتوي على مسار غير آمن.");
    }
    const unixMode = (entry.header.attr >>> 16) & 0o170000;
    if (unixMode === 0o120000) throw new Error("روابط الملفات الرمزية غير مسموحة داخل ZIP.");
    expanded += entry.header.size || 0;
    if (expanded > MAX_EXPANDED) throw new Error("الحجم بعد فك الضغط يتجاوز الحد المسموح.");
  }
  zip.extractAllTo(destination, true);
}

async function locateIndex(root) {
  const matches = [];
  async function walk(dir, depth = 0) {
    if (depth > 5) return;
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === "node_modules" || item.name === ".git" || item.name === "android") continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full, depth + 1);
      else if (/^index\.html?$/i.test(item.name)) matches.push(full);
    }
  }
  await walk(root);
  if (!matches.length) throw new Error("لم نعثر على index.html داخل المشروع.");
  if (matches.length > 1) {
    const rootIndex = matches.find(p => path.dirname(p) === root);
    if (!rootIndex) throw new Error("وجدنا أكثر من index.html. اجعل صفحة البداية واحدة في جذر المشروع.");
    return rootIndex;
  }
  return matches[0];
}

async function copyWebsite(sourceDir, targetDir) {
  const indexFile = await locateIndex(sourceDir);
  const base = path.dirname(indexFile);
  await fs.cp(base, targetDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(base, src).replace(/\\/g, "/");
      return !rel.split("/").some(part => ["node_modules", ".git", "android"].includes(part));
    }
  });
  await fs.access(path.join(targetDir, "index.html"));
}

function run(command, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = chunk => {
      const value = chunk.toString();
      output = (output + value).slice(-18000);
      for (const line of value.split(/\r?\n/)) if (line.trim()) onLine(line.slice(0, 500));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`${command} انتهى برمز ${code}.\n${output.slice(-5000)}`)));
  });
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

async function buildJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  const work = path.join(WORK_DIR, id);
  const webDir = path.join(work, "www");
  const projectDir = path.join(work, "project");
  const log = line => {
    const current = jobs.get(id);
    if (!current) return;
    current.logs.push(line);
    if (current.logs.length > 120) current.logs.shift();
    current.updatedAt = Date.now();
  };

  try {
    updateJob(id, { status: "building", stage: "تحضير الملفات" });
    await fs.mkdir(work, { recursive: true });
    const sourceDir = path.join(work, "source");
    await fs.mkdir(sourceDir, { recursive: true });

    if (job.extension === ".zip") {
      const zip = new AdmZip(job.uploadPath);
      safeExtract(zip, sourceDir);
    } else {
      const html = await fs.readFile(job.uploadPath);
      await fs.writeFile(path.join(sourceDir, "index.html"), html);
    }

    await copyWebsite(sourceDir, webDir);
    updateJob(id, { stage: "إعداد مشروع Android" });
    log("تم التحقق من ملفات الموقع.");

    await fs.mkdir(projectDir, { recursive: true });
    const packageJson = {
      name: "generated-android-app",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: { "@capacitor/core": "^7.4.3" },
      devDependencies: { "@capacitor/cli": "^7.4.3", "@capacitor/android": "^7.4.3" }
    };
    await fs.writeFile(path.join(projectDir, "package.json"), JSON.stringify(packageJson, null, 2));
    await fs.writeFile(path.join(projectDir, "capacitor.config.json"), JSON.stringify({
      appId: job.packageId,
      appName: job.appName,
      webDir: "www",
      bundledWebRuntime: false,
      server: { androidScheme: "https" }
    }, null, 2));
    await fs.cp(webDir, path.join(projectDir, "www"), { recursive: true });

    updateJob(id, { stage: "تثبيت محرك التطبيق" });
    log("تثبيت Capacitor...");
    await run("npm", ["install", "--no-audit", "--no-fund"], projectDir, log);

    updateJob(id, { stage: "إنشاء مشروع Android" });
    await run("npx", ["cap", "add", "android"], projectDir, log);
    await run("npx", ["cap", "sync", "android"], projectDir, log);

    updateJob(id, { stage: "بناء APK بواسطة Gradle" });
    log("بدأ بناء نسخة Android التجريبية...");
    await run("./gradlew", ["assembleDebug", "--no-daemon"], path.join(projectDir, "android"), log);

    const apkSource = path.join(projectDir, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
    await fs.access(apkSource);
    const apkName = `${id}.apk`;
    const apkTarget = path.join(OUTPUT_DIR, apkName);
    await fs.copyFile(apkSource, apkTarget);
    updateJob(id, { status: "completed", stage: "اكتمل البناء", downloadUrl: `/api/jobs/${id}/download`, apkName });
    log("اكتمل إنشاء APK بنجاح.");
  } catch (error) {
    updateJob(id, { status: "failed", stage: "فشل البناء", error: String(error.message || error).slice(0, 5000) });
    log(`خطأ: ${String(error.message || error).slice(0, 1000)}`);
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    await fs.rm(job.uploadPath, { force: true }).catch(() => {});
  }
}

function pumpQueue() {
  while (activeBuilds < MAX_CONCURRENT && queue.length) {
    const id = queue.shift();
    if (!jobs.has(id)) continue;
    activeBuilds++;
    buildJob(id).finally(() => { activeBuilds--; pumpQueue(); });
  }
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "HTML2APK Cloud" }));

app.post("/api/build", upload.single("website"), async (req, res) => {
  let uploadPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: "اختر ملف HTML أو ZIP أولاً." });
    const appName = cleanAppName(req.body.appName);
    const packageId = cleanPackageId(req.body.packageId);
    const id = nanoid(12);
    const extension = path.extname(req.file.originalname).toLowerCase();
    const job = {
      id, appName, packageId, extension, uploadPath,
      status: "queued", stage: "في قائمة الانتظار",
      logs: ["تم استلام طلب البناء."], createdAt: Date.now(), updatedAt: Date.now()
    };
    jobs.set(id, job);
    queue.push(id);
    pumpQueue();
    uploadPath = null;
    res.status(202).json({ id, status: job.status });
  } catch (error) {
    res.status(400).json({ error: error.message || "تعذر إنشاء طلب البناء." });
  } finally {
    if (uploadPath) await fs.rm(uploadPath, { force: true }).catch(() => {});
  }
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "طلب البناء غير موجود أو انتهت صلاحيته." });
  res.json({
    id: job.id, appName: job.appName, packageId: job.packageId,
    status: job.status, stage: job.stage, logs: job.logs,
    error: job.error || null, downloadUrl: job.downloadUrl || null,
    createdAt: job.createdAt, updatedAt: job.updatedAt
  });
});

app.get("/api/jobs/:id/download", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "completed") return res.status(404).json({ error: "ملف APK غير جاهز." });
  const file = path.join(OUTPUT_DIR, `${job.id}.apk`);
  try {
    await fs.access(file);
    res.download(file, `${job.appName.replace(/[^a-zA-Z0-9_-]/g, "_")}.apk`);
  } catch {
    res.status(404).json({ error: "انتهت صلاحية ملف APK." });
  }
});

setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL_MS && job.status !== "building") {
      jobs.delete(id);
      await fs.rm(path.join(OUTPUT_DIR, `${id}.apk`), { force: true }).catch(() => {});
      await fs.rm(job.uploadPath, { force: true }).catch(() => {});
    }
  }
}, 10 * 60 * 1000).unref();

app.use((err, _req, res, _next) => {
  const message = err instanceof multer.MulterError
    ? (err.code === "LIMIT_FILE_SIZE" ? "حجم الملف أكبر من 25 ميغابايت." : "تعذر استقبال الملف.")
    : (err.message || "حدث خطأ غير متوقع.");
  res.status(400).json({ error: message });
});

app.listen(PORT, "0.0.0.0", () => console.log(`HTML2APK Cloud listening on ${PORT}`));
