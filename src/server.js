const crypto = require("crypto");
const path = require("path");

const busboy = require("busboy");
const express = require("express");
const mime = require("mime-types");

const config = require("./config");
const {
  ensureBucket,
  getObjectBuffer,
  getObjectStream,
  listObjects,
  statObject,
  uploadObject,
  uploadObjectStream
} = require("./minio");

const app = express();

function requireToken(req, res, next) {
  const header = req.header("authorization");
  const token = header?.replace(/^Bearer\s+/i, "").trim();

  if (token !== config.apiToken) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  return next();
}

function buildAssetUrl(objectKey) {
  return `${config.publicBaseUrl}/assets/${encodeURIComponent(objectKey)}`;
}

function buildBatchUrl(batchId) {
  return `${config.publicBaseUrl}/uploads/${encodeURIComponent(batchId)}`;
}

function safeObjectName(originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  return `${Date.now()}-${crypto.randomUUID()}${ext}`;
}

function batchManifestKey(batchId) {
  return `uploads/${batchId}.json`;
}

async function saveBatchManifest(batchId, images) {
  const manifest = {
    batchId,
    createdAt: new Date().toISOString(),
    images
  };

  await uploadObject({
    objectName: batchManifestKey(batchId),
    buffer: Buffer.from(JSON.stringify(manifest, null, 2)),
    contentType: "application/json"
  });

  return manifest;
}

async function getBatchManifest(batchId) {
  const buffer = await getObjectBuffer(batchManifestKey(batchId));
  return JSON.parse(buffer.toString("utf8"));
}

function escapeHtml(value) {
  return String(value)
    .replace(/\r?\n|\r/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildBatchHtml(manifest) {
  const totalImages = manifest.images.length;
  const batchId = escapeHtml(manifest.batchId);
  const batchUrl = buildBatchUrl(manifest.batchId);
  const batchJsonUrl = `${batchUrl}/json`;
  const batchSummary = totalImages > 1
    ? "Browse the upload one image at a time."
    : totalImages === 1
      ? "Browse the upload at full size."
      : "This batch does not contain any images yet.";

  const imageSlides = manifest.images
    .map((item, index) => {
      const imageUrl = buildAssetUrl(item.objectKey);
      const safeName = escapeHtml(item.originalName || "Uploaded image");
      const slideNumber = index + 1;

      return `
        <figure class="slide${index === 0 ? " is-active" : ""}" data-carousel-slide data-carousel-slide-index="${index}" aria-label="Image ${slideNumber} of ${totalImages}">
          <div class="slide-frame">
            <img src="${imageUrl}" alt="${safeName}" loading="${index === 0 ? "eager" : "lazy"}" class="slide-image" />
          </div>
          <figcaption class="slide-caption">
            <div class="slide-copy">
              <p class="slide-kicker">Image ${slideNumber} of ${totalImages}</p>
              <h2 class="slide-title">${safeName}</h2>
            </div>
            <a href="${imageUrl}" target="_blank" rel="noreferrer" class="open-original">Open full size</a>
          </figcaption>
        </figure>
      `;
    })
    .join("");

  const carouselControls = totalImages > 1 ? `
          <div class="carousel-controls" aria-label="Carousel navigation">
            <button type="button" class="carousel-control" data-carousel-prev aria-label="Previous image">
              <span aria-hidden="true">&larr;</span>
            </button>
            <button type="button" class="carousel-control" data-carousel-next aria-label="Next image">
              <span aria-hidden="true">&rarr;</span>
            </button>
          </div>
  ` : "";

  const carouselDots = totalImages > 1 ? `
            <div class="carousel-dots" aria-label="Choose an image">
              ${manifest.images
                .map((_, index) => {
                  const isActive = index === 0 ? " is-active" : "";
                  const ariaCurrent = index === 0 ? "true" : "false";

                  return `
                <button type="button" class="carousel-dot${isActive}" data-carousel-dot data-target-index="${index}" aria-label="Go to image ${index + 1}" aria-current="${ariaCurrent}"></button>
              `;
                })
                .join("")}
            </div>
  ` : "";

  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>AssetLink Batch ${batchId}</title>
      <style>
        :root {
          color-scheme: light;
          --bg-primary: #f7f2eb;
          --bg-secondary: rgba(255, 255, 255, 0.84);
          --bg-surface: #ffffff;
          --text-primary: #2c2721;
          --text-secondary: #6f665a;
          --accent: #b8784b;
          --accent-strong: #8f5330;
          --border: rgba(44, 39, 33, 0.12);
          --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.05);
          --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.08);
          --shadow-lg: 0 18px 40px rgba(0, 0, 0, 0.12);
          --radius: 16px;
          --radius-lg: 22px;
          --radius-xl: 30px;
          --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          --page-gutter: clamp(12px, 2.4vw, 24px);
          --section-gap: clamp(18px, 3vw, 32px);
          --slide-gap: clamp(12px, 2vw, 18px);
          --slide-min-height: min(82vh, 900px);
          --slide-frame-min-height: clamp(320px, 62vh, 760px);
          --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          --font-serif: 'Cormorant Garamond', 'Times New Roman', serif;
        }
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        html {
          font-size: 16px;
          scroll-behavior: smooth;
        }
        body {
          margin: 0;
          font-family: var(--font-sans);
          overflow-x: hidden;
          background:
            radial-gradient(circle at top left, rgba(184, 120, 75, 0.16), transparent 26%),
            radial-gradient(circle at top right, rgba(143, 83, 48, 0.08), transparent 20%),
            linear-gradient(180deg, #fdf8f3 0%, var(--bg-primary) 100%);
          color: var(--text-primary);
          line-height: 1.6;
        }
        main {
          max-width: 1380px;
          margin: 0 auto;
          padding: clamp(20px, 4vw, 40px) var(--page-gutter) clamp(28px, 5vw, 56px);
          min-height: 100vh;
          min-height: 100dvh;
        }
        .header {
          text-align: center;
          margin-bottom: var(--section-gap);
          padding-bottom: clamp(18px, 2vw, 22px);
          border-bottom: 1px solid var(--border);
        }
        h1 {
          font-family: var(--font-serif);
          font-size: clamp(2.4rem, 5vw, 3.6rem);
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 12px;
          letter-spacing: -0.5px;
          line-height: 1.05;
          overflow-wrap: anywhere;
          word-break: break-word;
          text-wrap: balance;
        }
        .batch-info {
          display: flex;
          flex-direction: row;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: clamp(8px, 1.5vw, 10px);
          color: var(--text-secondary);
          font-size: clamp(0.95rem, 1.2vw, 1rem);
          margin-bottom: 10px;
        }
        .batch-id {
          font-family: var(--font-sans);
          font-weight: 500;
          background: var(--bg-surface);
          padding: 8px 16px;
          border-radius: 50px;
          border: 1px solid var(--border);
          font-size: 0.9rem;
        }
        .batch-summary {
          max-width: 760px;
          margin: 0 auto;
          color: var(--text-secondary);
          font-size: clamp(0.92rem, 1.2vw, 0.98rem);
          line-height: 1.55;
        }
        .actions {
          margin: 20px 0 6px;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: center;
          gap: clamp(10px, 1.6vw, 12px);
        }
        .actions a,
        .actions button {
          appearance: none;
          border: 1px solid var(--border);
          background: var(--bg-secondary);
          color: var(--accent);
          text-decoration: none;
          font-weight: 500;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          min-height: 44px;
          padding: 10px 16px;
          border-radius: 999px;
          box-shadow: var(--shadow-sm);
          transition: var(--transition);
          cursor: pointer;
          font: inherit;
          min-width: min(100%, 220px);
        }
        .actions a:hover,
        .actions button:hover {
          color: var(--accent-strong);
          border-color: rgba(184, 120, 75, 0.45);
          background: var(--bg-surface);
          box-shadow: var(--shadow-md);
          transform: translateY(-2px);
        }
        .actions button:focus-visible,
        .carousel-control:focus-visible,
        .carousel-dot:focus-visible,
        .open-original:focus-visible {
          outline: 2px solid rgba(184, 120, 75, 0.45);
          outline-offset: 2px;
        }
        .carousel {
          margin-top: var(--section-gap);
          position: relative;
        }
        .carousel-shell {
          position: relative;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: clamp(20px, 3vw, var(--radius-xl));
          box-shadow: var(--shadow-lg);
          overflow: hidden;
          backdrop-filter: blur(14px);
        }
        .carousel-viewport {
          overflow-x: auto;
          overflow-y: hidden;
          scroll-snap-type: x mandatory;
          scroll-behavior: smooth;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior-x: contain;
          scrollbar-width: none;
        }
        .carousel-viewport::-webkit-scrollbar {
          display: none;
        }
        .carousel-track {
          display: flex;
          align-items: stretch;
        }
        .slide {
          flex: 0 0 100%;
          padding: clamp(12px, 2vw, 28px);
          display: flex;
          flex-direction: column;
          gap: var(--slide-gap);
          min-height: var(--slide-min-height);
          scroll-snap-align: start;
          scroll-snap-stop: always;
        }
        .slide-frame {
          position: relative;
          flex: 1 1 auto;
          min-height: var(--slide-frame-min-height);
          padding: clamp(10px, 1.8vw, 18px);
          border-radius: clamp(16px, 2vw, calc(var(--radius-xl) - 10px));
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(247, 242, 234, 0.96));
          border: 1px solid rgba(44, 39, 33, 0.08);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.8),
            var(--shadow-md);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .slide-frame::after {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          pointer-events: none;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.5);
        }
        .slide-image {
          width: 100%;
          height: 100%;
          object-fit: contain;
          display: block;
          border-radius: clamp(12px, 1.5vw, calc(var(--radius-xl) - 16px));
          background: transparent;
        }
        .slide.is-active .slide-frame {
          border-color: rgba(184, 120, 75, 0.32);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.8),
            0 16px 36px rgba(44, 39, 33, 0.14);
        }
        .slide-caption {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: clamp(12px, 1.8vw, 16px);
          padding: 0 6px 4px;
        }
        .slide-copy {
          min-width: 0;
        }
        .slide-kicker {
          margin-bottom: 6px;
          font-size: 0.78rem;
          text-transform: uppercase;
          letter-spacing: 0.18em;
          color: var(--accent);
        }
        .slide-title {
          font-family: var(--font-serif);
          font-size: clamp(1.2rem, 2.2vw, 2rem);
          font-weight: 600;
          line-height: 1.15;
          word-break: break-word;
          color: var(--text-primary);
        }
        .open-original {
          flex: 0 0 auto;
          color: var(--accent-strong);
          text-decoration: none;
          font-weight: 600;
          white-space: nowrap;
          padding: 10px 14px;
          border-radius: 999px;
          border: 1px solid rgba(184, 120, 75, 0.18);
          background: rgba(184, 120, 75, 0.1);
          box-shadow: var(--shadow-sm);
          transition: var(--transition);
        }
        .open-original:hover {
          transform: translateY(-1px);
          box-shadow: var(--shadow-md);
        }
        .carousel-controls {
          position: absolute;
          inset: 50% 0 auto;
          transform: translateY(-50%);
          display: flex;
          justify-content: space-between;
          pointer-events: none;
          padding: 0 clamp(8px, 2vw, 14px);
        }
        .carousel-control {
          pointer-events: auto;
          display: grid;
          place-items: center;
          width: clamp(42px, 4vw, 50px);
          height: clamp(42px, 4vw, 50px);
          border: 1px solid rgba(255, 255, 255, 0.55);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.92);
          color: var(--text-primary);
          overflow: hidden;
          transition: var(--transition);
          box-shadow: var(--shadow-lg);
          cursor: pointer;
        }
        .carousel-control:hover {
          background: var(--bg-surface);
          transform: scale(1.04);
        }
        .carousel-control:disabled {
          opacity: 0.4;
          cursor: default;
          transform: none;
        }
        .carousel-footer {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: clamp(10px, 1.8vw, 14px);
          margin-top: clamp(14px, 2vw, 18px);
        }
        .carousel-status {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 14px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--bg-secondary);
          box-shadow: var(--shadow-sm);
          color: var(--text-secondary);
          font-weight: 500;
          font-size: clamp(0.9rem, 1.1vw, 1rem);
        }
        .carousel-dots {
          display: flex;
          justify-content: center;
          flex-wrap: wrap;
          gap: clamp(8px, 1.5vw, 10px);
          max-width: 100%;
        }
        .carousel-dot {
          width: clamp(9px, 1vw, 10px);
          height: clamp(9px, 1vw, 10px);
          border: none;
          border-radius: 999px;
          background: rgba(44, 39, 33, 0.22);
          padding: 0;
          cursor: pointer;
          transition: var(--transition);
        }
        .carousel-dot.is-active {
          width: clamp(22px, 2.4vw, 28px);
          background: var(--accent);
        }
        .carousel-dot:hover {
          background: var(--accent-strong);
        }
        .empty {
          margin-top: var(--section-gap);
          padding: clamp(44px, 8vw, 64px) 24px;
          text-align: center;
          background: var(--bg-secondary);
          border: 2px dashed var(--border);
          border-radius: var(--radius-xl);
          box-shadow: var(--shadow-sm);
          color: var(--text-secondary);
        }
        .empty-icon {
          font-size: 3rem;
          margin-bottom: 16px;
          color: var(--accent);
          opacity: 0.7;
        }
        .empty-title {
          font-family: var(--font-serif);
          font-size: 1.35rem;
          font-weight: 600;
          margin-bottom: 8px;
          color: var(--text-primary);
        }
        .empty-description {
          font-size: clamp(0.92rem, 1.1vw, 0.95rem);
          line-height: 1.55;
          max-width: 460px;
          margin: 0 auto;
        }
        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(18px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .header,
        .actions,
        .carousel,
        .empty {
          animation: fadeIn 0.5s ease-out forwards;
        }
        @media (max-width: 1024px) {
          :root {
            --slide-min-height: min(80vh, 860px);
            --slide-frame-min-height: clamp(280px, 58vh, 700px);
          }
          .slide-caption {
            align-items: center;
          }
        }
        @media (max-width: 768px) {
          main {
            padding: 20px 14px 34px;
          }
          h1 {
            font-size: clamp(2rem, 6vw, 2.8rem);
          }
          .batch-info {
            flex-direction: column;
            gap: 6px;
          }
          .actions {
            margin-top: 16px;
          }
          .actions a,
          .actions button {
            width: min(100%, 320px);
          }
          .carousel-shell {
            border: none;
            border-radius: 0;
            box-shadow: none;
            overflow: visible;
            backdrop-filter: none;
            background: transparent;
          }
          .carousel-viewport {
            overflow: visible;
            scroll-snap-type: none;
          }
          .carousel-track {
            display: block;
          }
          .slide {
            min-height: auto;
            padding: 0;
            gap: 10px;
            margin-bottom: 20px;
          }
          .slide-frame {
            min-height: auto;
            padding: 0;
            border: none;
            background: transparent;
            box-shadow: none;
          }
          .slide-frame::after {
            display: none;
          }
          .slide-image {
            width: 100%;
            height: auto;
            border-radius: var(--radius-lg);
          }
          .slide.is-active .slide-frame {
            border-color: transparent;
            box-shadow: none;
          }
          .slide-caption {
            flex-direction: column;
            align-items: flex-start;
            padding: 0 2px;
            gap: 8px;
          }
          .slide-kicker {
            display: none;
          }
          .slide-title {
            font-size: clamp(1.05rem, 4.8vw, 1.3rem);
          }
          .open-original {
            width: auto;
          }
          .carousel-controls,
          .carousel-status,
          .carousel-dots,
          .carousel-footer {
            display: none !important;
          }
          .empty {
            padding: 52px 20px;
          }
        }
        @media (max-width: 480px) {
          :root {
            --slide-min-height: auto;
            --slide-frame-min-height: auto;
          }
          h1 {
            font-size: clamp(1.65rem, 8vw, 2.1rem);
          }
          .batch-summary {
            font-size: 0.9rem;
          }
          .actions a,
          .actions button {
            width: 100%;
            min-width: 0;
          }
          .slide-title {
            font-size: clamp(1rem, 5vw, 1.2rem);
          }
        }
        @media (max-height: 720px) and (orientation: landscape) {
          :root {
            --slide-min-height: min(92vh, 640px);
            --slide-frame-min-height: clamp(220px, 58vh, 520px);
          }
          main {
            padding-top: 18px;
            padding-bottom: 24px;
          }
          .header {
            margin-bottom: 16px;
            padding-bottom: 14px;
          }
          .carousel {
            margin-top: 18px;
          }
          .slide-caption {
            flex-direction: row;
            align-items: center;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          html {
            scroll-behavior: auto;
          }
          .carousel-viewport {
            scroll-behavior: auto;
          }
          *,
          *::before,
          *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
        @media print {
          body {
            background: white;
            color: #000;
          }
          main {
            max-width: none;
            padding: 0;
          }
          .actions,
          .carousel-controls,
          .carousel-status,
          .carousel-dots {
            display: none !important;
          }
          .header {
            border-bottom: none;
            margin-bottom: 20px;
          }
          .carousel-shell {
            border: none;
            box-shadow: none;
            background: transparent;
          }
          .carousel-viewport {
            overflow: visible;
          }
          .carousel-track {
            display: block;
          }
          .slide {
            padding: 0 0 28px;
            min-height: auto;
            break-after: page;
            page-break-after: always;
          }
          .slide-frame {
            display: block;
            min-height: auto;
            padding: 0;
            border: none;
            box-shadow: none;
            background: transparent;
          }
          .slide-frame::after {
            display: none;
          }
          .slide-image {
            width: 100%;
            height: auto;
            max-height: 90vh;
          }
          .slide-caption {
            padding: 12px 0 0;
          }
        }
      </style>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Cormorant+Garamond:wght@600&display=swap" rel="stylesheet">
    </head>
    <body>
      <main>
        <div class="header">
          <h1>Batch ${batchId}</h1>
          <div class="batch-info">
            <span>${totalImages} ${totalImages === 1 ? "image" : "images"}</span>
            <span class="batch-id">${batchId}</span>
          </div>
          <p class="batch-summary">${batchSummary}</p>
        </div>
        <div class="actions">
          <a href="${batchJsonUrl}" target="_blank" rel="noreferrer">
            View JSON Data
          </a>
          <button type="button" data-print>
            Print Gallery
          </button>
        </div>
        ${totalImages > 0 ? `
          <section class="carousel" aria-label="Batch image carousel" data-carousel>
            <div class="carousel-shell">
              <div class="carousel-viewport" data-carousel-viewport tabindex="0">
                <div class="carousel-track">
                  ${imageSlides}
                </div>
              </div>
              ${carouselControls}
            </div>
            <div class="carousel-footer">
              <p class="carousel-status" data-carousel-status aria-live="polite">Image 1 of ${totalImages}</p>
              ${carouselDots}
            </div>
          </section>
        ` : `
          <div class="empty">
            <div class="empty-icon">📷</div>
            <h2 class="empty-title">No images uploaded yet</h2>
            <p class="empty-description">Upload images to browse them here in a full-size carousel.</p>
          </div>
        `}
      </main>
      <script>
        (() => {
          const printButton = document.querySelector('[data-print]');
          printButton?.addEventListener('click', () => window.print());

          const carousel = document.querySelector('[data-carousel]');
          if (!carousel) {
            return;
          }

          const isMobileLayout = window.matchMedia("(max-width: 768px)").matches;
          if (isMobileLayout) {
            return;
          }

          const viewport = carousel.querySelector('[data-carousel-viewport]');
          const slides = Array.from(carousel.querySelectorAll('[data-carousel-slide]'));
          const prevButton = carousel.querySelector('[data-carousel-prev]');
          const nextButton = carousel.querySelector('[data-carousel-next]');
          const status = carousel.querySelector('[data-carousel-status]');
          const dots = Array.from(carousel.querySelectorAll('[data-carousel-dot]'));
          let currentIndex = 0;

          if (!slides.length) {
            return;
          }

          slides.forEach((slide, index) => {
            slide.dataset.carouselSlideIndex = String(index);
          });

          const updateState = (index) => {
            const total = slides.length;
            currentIndex = ((index % total) + total) % total;

            slides.forEach((slide, slideIndex) => {
              slide.classList.toggle('is-active', slideIndex === currentIndex);
            });

            dots.forEach((dot, dotIndex) => {
              const isActive = dotIndex === currentIndex;
              dot.classList.toggle('is-active', isActive);
              dot.setAttribute('aria-current', isActive ? 'true' : 'false');
            });

            if (status) {
              status.textContent = 'Image ' + (currentIndex + 1) + ' of ' + total;
            }
          };

          const scrollToIndex = (index, behavior) => {
            updateState(index);
            slides[currentIndex].scrollIntoView({
              behavior: behavior || 'smooth',
              block: 'nearest',
              inline: 'start'
            });
          };

          if ("IntersectionObserver" in window) {
            const observer = new IntersectionObserver((entries) => {
              let visibleSlide = null;

              entries.forEach((entry) => {
                if (!entry.isIntersecting) {
                  return;
                }

                if (!visibleSlide || entry.intersectionRatio > visibleSlide.intersectionRatio) {
                  visibleSlide = entry;
                }
              });

              if (!visibleSlide) {
                return;
              }

              const nextIndex = Number(visibleSlide.target.dataset.carouselSlideIndex);
              if (!Number.isNaN(nextIndex) && nextIndex !== currentIndex) {
                updateState(nextIndex);
              }
            }, {
              root: viewport,
              threshold: [0.55, 0.75, 0.9]
            });

            slides.forEach((slide) => {
              observer.observe(slide);
            });
          }

          prevButton?.addEventListener('click', () => scrollToIndex(currentIndex - 1));
          nextButton?.addEventListener('click', () => scrollToIndex(currentIndex + 1));

          dots.forEach((dot) => {
            dot.addEventListener('click', () => {
              const targetIndex = Number(dot.dataset.targetIndex);
              if (Number.isNaN(targetIndex)) {
                return;
              }

              scrollToIndex(targetIndex);
            });
          });

          window.addEventListener('keydown', (event) => {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
              return;
            }

            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              scrollToIndex(currentIndex - 1);
              return;
            }

            if (event.key === 'ArrowRight') {
              event.preventDefault();
              scrollToIndex(currentIndex + 1);
              return;
            }

            if (event.key === 'Home') {
              event.preventDefault();
              scrollToIndex(0);
              return;
            }

            if (event.key === 'End') {
              event.preventDefault();
              scrollToIndex(slides.length - 1);
            }
          });

          updateState(0);
        })();
      </script>
    </body>
  </html>`;
}

app.get("/", (req, res) => {
  res.json({
    service: "AssetLink",
    uploadEndpoint: "POST /upload",
    auth: "Authorization: Bearer <API_TOKEN>",
    uploadResult: "Each upload returns a batch-specific link at /uploads/:batchId"
  });
});

app.post("/upload", requireToken, async (req, res, next) => {
  let parser;

  try {
    parser = busboy({
      headers: req.headers
    });
  } catch (error) {
    return res.status(400).json({
      error: "Request must be multipart/form-data"
    });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const batchId = crypto.randomUUID();
      const uploaded = [];
      const uploadTasks = [];
      let fileCount = 0;
      let imageIndex = 0;
      let failed = false;

      const fail = (error) => {
        if (failed) {
          return;
        }
        failed = true;
        reject(error);
      };

      parser.on("file", (fieldName, fileStream, info) => {
        const originalName = info.filename || "upload";
        const mimeType = info.mimeType || "application/octet-stream";

        if (fieldName !== "images") {
          fileStream.resume();
          return;
        }

        if (!mimeType.startsWith("image/")) {
          fileStream.resume();
          fail(new Error(`Unsupported file type for ${originalName}`));
          return;
        }

        fileCount += 1;
        const currentImageIndex = imageIndex;
        imageIndex += 1;

        const objectKey = safeObjectName(originalName);
        const uploadTask = uploadObjectStream({
          objectName: objectKey,
          stream: fileStream,
          contentType: mimeType
        })
          .then(() => {
            uploaded[currentImageIndex] = {
              originalName,
              objectKey,
              url: buildAssetUrl(objectKey)
            };
          })
          .catch(fail);

        fileStream.on("error", fail);
        uploadTasks.push(uploadTask);
      });

      parser.on("error", fail);

      parser.on("close", async () => {
        if (failed) {
          return;
        }

        try {
          await Promise.all(uploadTasks);

          if (fileCount === 0) {
            return reject(new Error("At least one image file is required in the images field"));
          }

          await saveBatchManifest(batchId, uploaded);

          resolve({
            message: "Images uploaded successfully",
            batchId,
            batchUrl: buildBatchUrl(batchId),
            batchJsonUrl: `${buildBatchUrl(batchId)}/json`,
            images: uploaded
          });
        } catch (error) {
          fail(error);
        }
      });

      req.pipe(parser);
    });

    return res.status(201).json(result);
  } catch (error) {
    if (error.message === "At least one image file is required in the images field") {
      return res.status(400).json({
        error: error.message
      });
    }

    if (error.message.startsWith("Unsupported file type for ")) {
      return res.status(400).json({
        error: error.message
      });
    }

    return next(error);
  }
});

app.get("/assets/:objectKey", async (req, res, next) => {
  try {
    const objectKey = req.params.objectKey;
    const meta = await statObject(objectKey);
    const stream = await getObjectStream(objectKey);

    res.setHeader("Content-Type", meta.metaData["content-type"] || mime.lookup(objectKey) || "application/octet-stream");
    stream.pipe(res);
  } catch (error) {
    if (error.code === "NotFound" || error.code === "NoSuchKey") {
      return res.status(404).json({
        error: "Image not found"
      });
    }
    return next(error);
  }
});

app.get("/images", async (req, res, next) => {
  try {
    const objects = await listObjects();
    return res.json({
      total: objects.filter((item) => !item.name.startsWith("uploads/")).length,
      images: objects
        .filter((item) => !item.name.startsWith("uploads/"))
        .map((item) => ({
        objectKey: item.name,
        size: item.size,
        lastModified: item.lastModified,
        url: buildAssetUrl(item.name)
        }))
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/uploads/:batchId/json", async (req, res, next) => {
  try {
    const manifest = await getBatchManifest(req.params.batchId);
    return res.json({
      ...manifest,
      batchUrl: buildBatchUrl(manifest.batchId)
    });
  } catch (error) {
    if (error.code === "NotFound" || error.code === "NoSuchKey" || error.name === "S3Error") {
      return res.status(404).json({
        error: "Upload batch not found"
      });
    }
    return next(error);
  }
});

app.get("/uploads/:batchId", async (req, res, next) => {
  try {
    const manifest = await getBatchManifest(req.params.batchId);
    const html = buildBatchHtml(manifest);
    return res.type("html").send(html);
  } catch (error) {
    if (error.code === "NotFound" || error.code === "NoSuchKey" || error.name === "S3Error") {
      return res.status(404).json({
        error: "Upload batch not found"
      });
    }
    return next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({
    error: "Internal server error"
  });
});

ensureBucket()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`AssetLink listening on port ${config.port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
