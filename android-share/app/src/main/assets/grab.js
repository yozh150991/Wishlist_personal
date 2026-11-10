// Згенеровано з app/src/lib/bookmarklet.ts (pageGrab) — не редагувати вручну.
// Оновлення: cd app && npm run build:android-grab
(function pageGrab(origin) {
  var d = document;
  var name = "";
  var price = "";
  var cur = "";
  var img = "";
  var steps = 0;
  var str = function(v) {
    return typeof v === "string" ? v.trim() : typeof v === "number" && isFinite(v) ? String(v) : "";
  };
  var imgOf = function(v) {
    if (Array.isArray(v)) return v.length ? imgOf(v[0]) : "";
    if (v && typeof v === "object") {
      var o = v;
      return str(o.url) || str(o.contentUrl);
    }
    return str(v);
  };
  var offerOf = function(v) {
    var list = [].concat(v || []);
    for (var j = 0; j < list.length && !price; j++) {
      var of = list[j];
      if (!of || typeof of !== "object") continue;
      var spec = of.priceSpecification;
      var p = str(of.price) || str(of.lowPrice) || (spec && typeof spec === "object" ? str(spec.price) : "");
      if (p) {
        price = p;
        cur = str(of.priceCurrency) || (spec && typeof spec === "object" ? str(spec.priceCurrency) : "");
      }
    }
  };
  var walk = function(n) {
    if (!n || typeof n !== "object" || name || steps++ > 500) return;
    if (Array.isArray(n)) {
      for (var i = 0; i < n.length; i++) walk(n[i]);
      return;
    }
    var o = n;
    var types = [].concat(o["@type"] || []);
    if (types.indexOf("Product") >= 0 || types.indexOf("ProductGroup") >= 0) {
      name = str(o.name);
      img = imgOf(o.image);
      offerOf(o.offers);
      var variants = [].concat(o.hasVariant || []);
      for (var k = 0; k < variants.length && !price; k++) {
        var vr = variants[k];
        if (vr && typeof vr === "object") {
          offerOf(vr.offers);
          if (!img) img = imgOf(vr.image);
        }
      }
      return;
    }
    walk(o["@graph"]);
    walk(o.mainEntity);
  };
  var meta = function(k) {
    var e = d.querySelector('meta[property="' + k + '"],meta[name="' + k + '"],meta[itemprop="' + k + '"]');
    return e ? (e.getAttribute("content") || "").trim() : "";
  };
  var blocks = d.querySelectorAll('script[type="application/ld+json"]');
  for (var b = 0; b < blocks.length && !name; b++) {
    try {
      walk(JSON.parse(blocks[b].textContent || ""));
    } catch (e) {
    }
  }
  if (name && /&[#a-z0-9]+;/i.test(name)) {
    try {
      var ta = d.createElement("textarea");
      ta.innerHTML = name;
      name = ta.value;
    } catch (e) {
    }
  }
  var h1 = d.querySelector("h1");
  var h1Text = h1 ? (h1.textContent || "").replace(/\s+/g, " ").trim() : "";
  name = name || meta("og:title") || meta("twitter:title") || (h1Text.length <= 300 ? h1Text : "") || d.title.trim();
  if (!price) {
    price = meta("product:price:amount") || meta("og:price:amount") || meta("price");
    cur = meta("product:price:currency") || meta("og:price:currency") || meta("priceCurrency");
  }
  img = img || meta("og:image:secure_url") || meta("og:image") || meta("twitter:image");
  var view = (window.innerHeight || 800) * 2;
  var scrollTop = window.scrollY || 0;
  if (!price) {
    var SIGNS = [["z\u0142", "PLN"], ["pln", "PLN"], ["\u20B4", "UAH"], ["\u0433\u0440\u043D", "UAH"], ["uah", "UAH"], ["\u20AC", "EUR"], ["eur", "EUR"], ["$", "USD"], ["usd", "USD"]];
    var NUM = /\d{1,3}(?:[ \u00a0\u202f.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/;
    var best = 0;
    var bestTop = 0;
    var cands = d.querySelectorAll('[itemprop="price"],[class*="price" i],[id*="price" i],[data-testid*="price" i]');
    for (var c = 0; c < cands.length && c < 400; c++) {
      var el = cands[c];
      if (el.closest("s,del,strike")) continue;
      var cs = getComputedStyle(el);
      if ((cs.textDecorationLine || "").indexOf("line-through") >= 0) continue;
      var r = el.getBoundingClientRect();
      var top = r.top + scrollTop;
      if (r.width < 2 || r.height < 2 || top > view || r.right < 0) continue;
      var tx = (el.getAttribute("itemprop") === "price" && el.getAttribute("content") || el.innerText || "").replace(/\s+/g, " ").trim();
      if (!tx || tx.length > 60) continue;
      var m = tx.match(NUM);
      if (!m) continue;
      var low = tx.toLowerCase();
      var sign = "";
      for (var s = 0; s < SIGNS.length && !sign; s++) if (low.indexOf(SIGNS[s][0]) >= 0) sign = SIGNS[s][1];
      if (!sign && !/\d[.,](?:\d{2}(?!\d)|\s?[-\u2013\u2014](?![\d-]))/.test(tx) && el.getAttribute("itemprop") !== "price") continue;
      var size = parseFloat(cs.fontSize) || 0;
      var struck = false;
      var kids = el.querySelectorAll("*");
      for (var k2 = 0; k2 < kids.length && k2 < 20; k2++) {
        var ks = getComputedStyle(kids[k2]);
        if ((ks.textDecorationLine || "").indexOf("line-through") >= 0 || kids[k2].matches("s,del,strike")) struck = true;
        size = Math.max(size, parseFloat(ks.fontSize) || 0);
      }
      if (struck) continue;
      if (size > best || size === best && top < bestTop) {
        best = size;
        bestTop = top;
        price = m[0];
        cur = sign;
      }
    }
  }
  if (!img) {
    var area = 0;
    for (var g = 0; g < d.images.length && g < 300; g++) {
      var im = d.images[g];
      var ir = im.getBoundingClientRect();
      var src = im.currentSrc || im.src;
      if (ir.width < 120 || ir.height < 120 || ir.top + scrollTop > view || !/^https:/.test(src)) continue;
      if (ir.width * ir.height > area) {
        area = ir.width * ir.height;
        img = src;
      }
    }
  }
  try {
    img = img ? new URL(img, location.href).href : "";
  } catch (e) {
    img = "";
  }
  var q = new URLSearchParams();
  q.set("src", "page");
  q.set("url", location.href.split("#")[0]);
  if (name) q.set("title", name.replace(/\s+/g, " ").slice(0, 300));
  if (price) q.set("price", price.slice(0, 40));
  if (cur) q.set("currency", cur.slice(0, 8));
  if (img && img.length <= 2048) q.set("image", img);
  var target = origin.replace(/\/+$/, "") + "/add?" + q.toString();
  if (typeof completion !== "undefined") {
    completion(target);
    return;
  }
  var w = window.open(target, "_blank");
  if (!w) location.href = target;
})
