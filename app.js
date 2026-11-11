const form = document.querySelector("#buildForm");
const fileInput = document.querySelector("#website");
const dropzone = document.querySelector("#dropzone");
const fileTitle = document.querySelector("#fileTitle");
const fileHint = document.querySelector("#fileHint");
const fileChip = document.querySelector("#fileChip");
const buildButton = document.querySelector("#buildButton");
const resultPanel = document.querySelector("#resultPanel");
const statusBadge = document.querySelector("#statusBadge");
const progressBar = document.querySelector("#progressBar");
const stageText = document.querySelector("#stageText");
const jobIdText = document.querySelector("#jobId");
const logBox = document.querySelector("#logBox");
const errorBox = document.querySelector("#errorBox");
const downloadButton = document.querySelector("#downloadButton");
const newBuildButton = document.querySelector("#newBuildButton");

let pollTimer = null;
let currentJobId = null;

function showFile(file) {
  if (!file) return;
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["html", "htm", "zip"].includes(ext)) {
    fileInput.value = "";
    fileTitle.textContent = "نوع الملف غير مدعوم";
    fileHint.textContent = "اختر ملف HTML أو ZIP.";
    fileChip.hidden = true;
    return;
  }
  fileTitle.textContent = "تم اختيار الملف";
  fileHint.textContent = "ملفك جاهز للإرسال إلى محرك البناء.";
  fileChip.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  fileChip.hidden = false;
}
fileInput.addEventListener("change", () => showFile(fileInput.files[0]));
["dragenter", "dragover"].forEach(type => dropzone.addEventListener(type, event => {
  event.preventDefault(); dropzone.classList.add("dragover");
}));
["dragleave", "drop"].forEach(type => dropzone.addEventListener(type, event => {
  event.preventDefault(); dropzone.classList.remove("dragover");
}));
dropzone.addEventListener("drop", event => {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  showFile(file);
});

function setBusy(busy) {
  buildButton.disabled = busy;
  buildButton.querySelector("span").textContent = busy ? "جارٍ إرسال طلب البناء..." : "ابدأ بناء التطبيق";
}
function progressFor(status, stage) {
  if (status === "queued") return 8;
  if (status === "failed") return 100;
  if (status === "completed") return 100;
  const map = {
    "تحضير الملفات": 18,
    "إعداد مشروع Android": 30,
    "تثبيت محرك التطبيق": 48,
    "إنشاء مشروع Android": 65,
    "بناء APK بواسطة Gradle": 82
  };
  return map[stage] || 35;
}
function setStatus(status) {
  statusBadge.className = "status-badge";
  if (status === "completed") {
    statusBadge.textContent = "اكتمل بنجاح";
    statusBadge.classList.add("success");
  } else if (status === "failed") {
    statusBadge.textContent = "فشل البناء";
    statusBadge.classList.add("error");
  } else if (status === "building") statusBadge.textContent = "قيد التنفيذ";
  else statusBadge.textContent = "في الانتظار";
}
function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}
async function pollJob(id) {
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "تعذر جلب حالة البناء.");
    stageText.textContent = data.stage;
    jobIdText.textContent = `JOB ${data.id}`;
    statusBadge && setStatus(data.status);
    progressBar.style.width = `${progressFor(data.status, data.stage)}%`;
    logBox.textContent = (data.logs || []).join("\n");
    logBox.scrollTop = logBox.scrollHeight;
    if (data.status === "completed") {
      downloadButton.href = data.downloadUrl;
      downloadButton.hidden = false;
      setBusy(false);
      return;
    }
    if (data.status === "failed") {
      errorBox.textContent = data.error || "حدث خطأ أثناء البناء.";
      errorBox.hidden = false;
      setBusy(false);
      return;
    }
    pollTimer = setTimeout(() => pollJob(id), 2500);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    setBusy(false);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  errorBox.hidden = true;
  downloadButton.hidden = true;
  const file = fileInput.files[0];
  if (!file) {
    fileTitle.textContent = "اختر ملف HTML أو ZIP أولاً";
    return;
  }
  const appName = document.querySelector("#appName").value.trim();
  const packageId = document.querySelector("#packageId").value.trim();
  if (!appName || appName.length > 40) return alert("أدخل اسم تطبيق صحيحاً (حتى 40 حرفاً).");
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,8}$/.test(packageId)) {
    return alert("معرّف الحزمة غير صالح. مثال: com.example.myapp");
  }
  if (file.size > 25 * 1024 * 1024) return alert("حجم الملف يتجاوز 25MB.");
  const body = new FormData();
  body.append("website", file);
  body.append("appName", appName);
  body.append("packageId", packageId);

  resultPanel.hidden = false;
  resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  logBox.textContent = "جارٍ إرسال الملفات...";
  stageText.textContent = "إرسال الطلب";
  setBusy(true);
  stopPolling();

  try {
    const response = await fetch("/api/build", { method: "POST", body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "تعذر إرسال طلب البناء.");
    currentJobId = data.id;
    pollJob(currentJobId);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    setBusy(false);
  }
});

newBuildButton.addEventListener("click", () => {
  stopPolling();
  currentJobId = null;
  resultPanel.hidden = true;
  form.reset();
  fileTitle.innerHTML = 'اسحب ملفك إلى هنا أو <span>تصفّح الملفات</span>';
  fileHint.textContent = "ملف HTML واحد أو ZIP يحتوي على index.html وبقية ملفات الموقع";
  fileChip.hidden = true;
  errorBox.hidden = true;
  downloadButton.hidden = true;
  setBusy(false);
  window.scrollTo({ top: 0, behavior: "smooth" });
});
