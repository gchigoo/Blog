(function () {
  'use strict';

  function initImageZoom() {
    var articleContent = document.querySelector('.article-content');
    if (!articleContent) return;

    var overlay = document.getElementById('image-lightbox');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'image-lightbox';
      overlay.className = 'image-lightbox';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', '图片预览');
      overlay.setAttribute('tabindex', '-1');
      overlay.innerHTML =
        '<div class="image-lightbox-backdrop"></div>' +
        '<div class="image-lightbox-container">' +
          '<button type="button" class="image-lightbox-close" aria-label="关闭预览" title="关闭 (ESC)">' +
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
              '<line x1="18" y1="6" x2="6" y2="18"></line>' +
              '<line x1="6" y1="6" x2="18" y2="18"></line>' +
            '</svg>' +
          '</button>' +
          '<div class="image-lightbox-content">' +
            '<img class="image-lightbox-img" src="" alt="">' +
            '<p class="image-lightbox-caption"></p>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
    }

    var imgEl = overlay.querySelector('.image-lightbox-img');
    var captionEl = overlay.querySelector('.image-lightbox-caption');
    var closeBtn = overlay.querySelector('.image-lightbox-close');
    var backdrop = overlay.querySelector('.image-lightbox-backdrop');

    function openLightbox(src, alt) {
      imgEl.src = src;
      imgEl.alt = alt || '';
      if (alt && alt.trim()) {
        captionEl.textContent = alt.trim();
        captionEl.style.display = 'block';
      } else {
        captionEl.textContent = '';
        captionEl.style.display = 'none';
      }
      overlay.classList.add('is-active');
      document.body.classList.add('lightbox-open');
      closeBtn.focus();
    }

    function closeLightbox() {
      overlay.classList.remove('is-active');
      document.body.classList.remove('lightbox-open');
      setTimeout(function () {
        if (!overlay.classList.contains('is-active')) {
          imgEl.src = '';
        }
      }, 250);
    }

    articleContent.addEventListener('click', function (e) {
      var link = e.target.closest('a');
      if (link && articleContent.contains(link)) {
        var img = link.querySelector('img');
        if (img) {
          var href = link.getAttribute('href');
          if (href && /\.(webp|jpg|jpeg|png|gif|svg|avif)(\?.*)?$/i.test(href)) {
            e.preventDefault();
            openLightbox(href, img.getAttribute('alt') || '');
            return;
          }
        }
      }

      if (e.target.tagName === 'IMG' && articleContent.contains(e.target)) {
        var parentLink = e.target.closest('a');
        if (!parentLink) {
          e.preventDefault();
          openLightbox(e.target.currentSrc || e.target.src, e.target.getAttribute('alt') || '');
        }
      }
    });

    closeBtn.addEventListener('click', closeLightbox);
    backdrop.addEventListener('click', closeLightbox);

    overlay.querySelector('.image-lightbox-container').addEventListener('click', function (e) {
      if (e.target === this || e.target.classList.contains('image-lightbox-content')) {
        closeLightbox();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.classList.contains('is-active')) {
        closeLightbox();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initImageZoom);
  } else {
    initImageZoom();
  }
})();
