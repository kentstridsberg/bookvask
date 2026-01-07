const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "public/icons/icon.svg");
const OUT = path.join(__dirname, "public/icons");

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

async function run() {
  // 192x192
  await sharp(SRC).resize(192, 192).png().toFile(path.join(OUT, "icon-192.png"));

  // 512x512
  await sharp(SRC).resize(512, 512).png().toFile(path.join(OUT, "icon-512.png"));

  // 512x512 maskable (litt “margin” så den ikke klippes i Android)
  await sharp(SRC)
    .resize(420, 420)
    .extend({
      top: 46, bottom: 46, left: 46, right: 46,
      background: { r: 246, g: 247, b: 251, alpha: 1 }
    })
    .resize(512, 512)
    .png()
    .toFile(path.join(OUT, "icon-512-maskable.png"));

  console.log("✅ Ikoner generert i public/icons/");
}

run().catch((e) => {
  console.error("❌ Feil:", e);
  process.exit(1);
});