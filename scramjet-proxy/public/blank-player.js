(function () {
  "use strict";

  var state = window._musicState || { queue: [], index: -1, shuffle: false, repeat: false, minimized: true, volume: 80, currentTime: 0 };
  var musicQueue = state.queue || [];
  var musicIndex = state.index != null ? state.index : -1;
  var musicShuffle = !!state.shuffle;
  var musicRepeat = !!state.repeat;
  var musicMinimized = state.minimized !== false;
  var savedVolume = state.volume != null ? state.volume : 80;
  var savedCurrentTime = state.currentTime || 0;

  var musicEl = document.getElementById("music-player");
  var musicThumb = document.getElementById("music-thumb");
  var musicTitle = document.getElementById("music-title");
  var musicAuthor = document.getElementById("music-author");
  var musicFullThumb = document.getElementById("music-full-thumb");
  var musicFullTitle = document.getElementById("music-full-title");
  var musicFullAuthor = document.getElementById("music-full-author");
  var musicPlayBtn = document.getElementById("music-play-btn");
  var musicPlayIcon = document.getElementById("music-play-icon");
  var musicPrevBtn = document.getElementById("music-prev-btn");
  var musicNextBtn = document.getElementById("music-next-btn");
  var musicShuffleBtn = document.getElementById("music-shuffle-btn");
  var musicRepeatBtn = document.getElementById("music-repeat-btn");
  var musicSearchInput = document.getElementById("music-search-input");
  var musicResults = document.getElementById("music-results");
  var musicSearchToggle = document.getElementById("music-search-toggle");
  var musicSearchArea = document.getElementById("music-search-area");
  var musicToggleBtn = document.getElementById("music-toggle-btn");
  var musicToggleIcon = document.getElementById("music-toggle-icon");
  var musicProgressFill = document.getElementById("music-progress-fill");
  var musicProgressBar = document.getElementById("music-progress-bar");
  var musicCurrentTime = document.getElementById("music-current-time");
  var musicDuration = document.getElementById("music-duration");
  var musicVolume = document.getElementById("music-volume");
  var musicQueueList = document.getElementById("music-queue-list");
  var musicQueueCount = document.getElementById("music-queue-count");
  var musicPlayerArea = document.getElementById("music-player-area");

  var ytPlayer = null;
  var ytReady = false;
  var ytLoadAttempted = false;
  var musicPlayerApiFailed = 0;
  var progressInterval = null;

  window.FALLBACK_THUMB =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%231a1a2e' rx='8'/%3E%3Ctext x='50' y='65' text-anchor='middle' font-size='35' fill='%23888'%3E%E2%99%AA%3C/text%3E%3C/svg%3E";

  function formatTime(t) {
    if (!t || isNaN(t)) return "0:00";
    var m = Math.floor(t / 60);
    var s = Math.floor(t % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function updateProgress() {
    if (!ytPlayer || !ytPlayer.getCurrentTime) return;
    var current = ytPlayer.getCurrentTime();
    var dur = ytPlayer.getDuration();
    if (dur > 0) {
      musicProgressFill.style.width = (current / dur) * 100 + "%";
    }
    musicCurrentTime.textContent = formatTime(current);
    musicDuration.textContent = formatTime(dur);
  }

  function updatePlayIcon(playing) {
    musicPlayIcon.innerHTML = playing
      ? '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>'
      : '<polygon points="5 3 19 12 5 21 5 3"/>';
  }

  function updateNowPlaying(track) {
    var thumb = track.thumbnail || "https://i.ytimg.com/vi/" + track.id + "/mqdefault.jpg";
    musicThumb.src = thumb;
    musicTitle.textContent = track.title;
    musicAuthor.textContent = track.author;
    musicFullThumb.src = thumb;
    musicFullTitle.textContent = track.title;
    musicFullAuthor.textContent = track.author;
  }

  function playCurrent() {
    if (musicIndex < 0 || musicIndex >= musicQueue.length) return;
    var track = musicQueue[musicIndex];
    if (ytPlayer && ytPlayer.loadVideoById) {
      ytPlayer.loadVideoById(track.id);
      ytPlayer.playVideo();
    }
    updateNowPlaying(track);
    updateQueueUI();
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = setInterval(updateProgress, 500);
  }

  function stopPlayback() {
    if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
    if (progressInterval) clearInterval(progressInterval);
    musicProgressFill.style.width = "0%";
    musicCurrentTime.textContent = "0:00";
    musicDuration.textContent = "0:00";
    musicThumb.removeAttribute("src");
    musicFullThumb.removeAttribute("src");
    musicTitle.textContent = "No track";
    musicAuthor.textContent = "";
    musicFullTitle.textContent = "No track selected";
    musicFullAuthor.textContent = "";
    updatePlayIcon(false);
  }

  function playSong(videoId, title, author, thumbnail) {
    var existingIdx = -1;
    for (var i = 0; i < musicQueue.length; i++) {
      if (musicQueue[i].id === videoId) { existingIdx = i; break; }
    }
    if (existingIdx >= 0) {
      musicIndex = existingIdx;
    } else {
      musicQueue.push({ id: videoId, title: title, author: author, thumbnail: thumbnail });
      musicIndex = musicQueue.length - 1;
    }
    updateQueueUI();
    musicEl.classList.remove("music-hidden");
    if (!ytReady) {
      var thumb = thumbnail || "https://i.ytimg.com/vi/" + videoId + "/mqdefault.jpg";
      musicTitle.textContent = title;
      musicAuthor.textContent = author;
      musicThumb.src = thumb;
      musicFullThumb.src = thumb;
      musicFullTitle.textContent = title;
      musicFullAuthor.textContent = author;
      musicProgressFill.style.width = "0%";
      musicCurrentTime.textContent = "0:00";
      musicDuration.textContent = "0:00";
      updatePlayIcon(false);
      return;
    }
    playCurrent();
  }

  function togglePlay() {
    if (!ytReady || musicIndex < 0) return;
    var state$1 = ytPlayer.getPlayerState();
    if (state$1 === YT.PlayerState.PLAYING) {
      ytPlayer.pauseVideo();
      if (progressInterval) clearInterval(progressInterval);
    } else {
      ytPlayer.playVideo();
      if (progressInterval) clearInterval(progressInterval);
      progressInterval = setInterval(updateProgress, 500);
    }
  }

  function playNext() {
    if (musicQueue.length === 0) return;
    if (musicShuffle) {
      musicIndex = Math.floor(Math.random() * musicQueue.length);
    } else if (musicIndex < musicQueue.length - 1) {
      musicIndex++;
    } else if (musicRepeat) {
      musicIndex = 0;
    } else return;
    playCurrent();
  }

  function playPrev() {
    if (musicQueue.length === 0) return;
    if (ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getCurrentTime() > 3) {
      ytPlayer.seekTo(0);
      return;
    }
    if (musicIndex > 0) {
      musicIndex--;
    } else if (musicRepeat) {
      musicIndex = musicQueue.length - 1;
    } else return;
    playCurrent();
  }

  function toggleShuffle() {
    musicShuffle = !musicShuffle;
    musicShuffleBtn.classList.toggle("active", musicShuffle);
  }

  function toggleRepeat() {
    musicRepeat = !musicRepeat;
    musicRepeatBtn.classList.toggle("active", musicRepeat);
  }

  function toggleMinimize() {
    musicMinimized = !musicMinimized;
    musicEl.classList.toggle("music-minimized", musicMinimized);
    musicToggleIcon.innerHTML = musicMinimized
      ? '<polyline points="18 15 12 9 6 15"/>'
      : '<polyline points="6 9 12 15 18 9"/>';
    musicToggleBtn.title = musicMinimized ? "Maximize" : "Minimize";
  }

  function updateQueueUI() {
    var html = "";
    for (var i = 0; i < musicQueue.length; i++) {
      var t = musicQueue[i];
      var thumb = t.thumbnail || "https://i.ytimg.com/vi/" + t.id + "/mqdefault.jpg";
      html += '<div class="music-qitem ' + (i === musicIndex ? "active" : "") + '" data-idx="' + i + '">';
      html += '<img src="' + thumb + '" alt="" onerror="this.src=window.FALLBACK_THUMB" />';
      html += '<span class="q-title">' + escHtml(t.title) + '</span>';
      html += '<button class="q-remove" data-idx="' + i + '">\u00d7</button>';
      html += "</div>";
    }
    musicQueueList.innerHTML = html;
    musicQueueCount.textContent = musicQueue.length + " song" + (musicQueue.length !== 1 ? "s" : "");
    var items = musicQueueList.querySelectorAll(".music-qitem");
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener("click", function (e) {
        if (e.target.classList.contains("q-remove")) return;
        musicIndex = parseInt(this.dataset.idx);
        playCurrent();
      });
    }
    var removes = musicQueueList.querySelectorAll(".q-remove");
    for (var k = 0; k < removes.length; k++) {
      removes[k].addEventListener("click", function (e) {
        e.stopPropagation();
        var idx = parseInt(this.dataset.idx);
        musicQueue.splice(idx, 1);
        if (idx < musicIndex) musicIndex--;
        else if (idx === musicIndex) {
          if (musicQueue.length === 0) { musicIndex = -1; stopPlayback(); }
          else { if (musicIndex >= musicQueue.length) musicIndex = musicQueue.length - 1; playCurrent(); }
        }
        updateQueueUI();
      });
    }
  }

  function escHtml(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function doMusicSearch(q) {
    musicResults.innerHTML = '<div class="music-loading"><span></span><span></span><span></span></div>';
    fetch("/api/music/search?q=" + encodeURIComponent(q))
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (data) {
        var results = data.results || [];
        if (results.length === 0) {
          musicResults.innerHTML = "<div style='padding:8px;color:#888;font-size:12px'>No results found</div>";
          return;
        }
        var html = "";
        for (var i = 0; i < results.length; i++) {
          var r = results[i];
          html += '<div class="music-result-item" data-id="' + r.id + '" data-title="' + escHtml(r.title) + '" data-author="' + escHtml(r.author) + '" data-thumb="' + r.thumbnail + '">';
          html += '<img src="' + r.thumbnail + '" alt="" loading="lazy" onerror="this.src=window.FALLBACK_THUMB" />';
          html += '<div class="r-title">' + escHtml(r.title) + '</div>';
          html += '<div class="r-meta">' + r.author + " \u00b7 " + r.duration + "</div>";
          html += "</div>";
        }
        musicResults.innerHTML = html;
        var items = musicResults.querySelectorAll(".music-result-item");
        for (var j = 0; j < items.length; j++) {
          items[j].addEventListener("click", function () {
            playSong(this.dataset.id, this.dataset.title, this.dataset.author, this.dataset.thumb);
            musicSearchInput.value = "";
            musicResults.innerHTML = "";
            musicSearchArea.classList.add("music-hidden");
          });
        }
      })
      .catch(function () {
        musicResults.innerHTML = "<div style='padding:8px;color:#888;font-size:12px'>Search failed</div>";
      });
  }

  function loadYouTubeAPI() {
    if (ytLoadAttempted) return;
    ytLoadAttempted = true;
    if (typeof YT !== "undefined" && YT.Player) { onYouTubeIframeAPIReady(); return; }
    if (musicPlayerApiFailed >= 2) return;
    var tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.onerror = function () {
      musicPlayerApiFailed++;
      ytLoadAttempted = false;
      if (musicPlayerApiFailed >= 3) {
        musicEl.classList.add("music-api-failed");
      } else {
        setTimeout(loadYouTubeAPI, 3000);
      }
    };
    var first = document.getElementsByTagName("script")[0];
    first.parentNode.insertBefore(tag, first);
  }

  function onYouTubeIframeAPIReady() {
    ytPlayer = new YT.Player("music-youtube-player", {
      height: "0",
      width: "0",
      playerVars: {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        playsinline: 1,
        rel: 0,
        iv_load_policy: 3,
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: onPlayerError,
      },
    });
  }

  function onPlayerReady() {
    ytReady = true;
    ytPlayer.setVolume(savedVolume);
    musicVolume.value = savedVolume;
    if (musicIndex >= 0 && musicIndex < musicQueue.length) {
      playCurrent();
      if (savedCurrentTime > 0) {
        setTimeout(function () { ytPlayer.seekTo(savedCurrentTime); }, 500);
      }
    }
  }

  function onPlayerStateChange(e) {
    if (e.data === YT.PlayerState.ENDED) {
      if (musicRepeat) {
        ytPlayer.seekTo(0);
        ytPlayer.playVideo();
      } else if (musicIndex < musicQueue.length - 1) {
        musicIndex++;
        playCurrent();
      } else if (musicShuffle) {
        musicIndex = Math.floor(Math.random() * musicQueue.length);
        playCurrent();
      } else {
        updatePlayIcon(false);
        if (progressInterval) clearInterval(progressInterval);
      }
    }
    updatePlayIcon(e.data === YT.PlayerState.PLAYING);
  }

  function onPlayerError() {
    if (musicIndex >= 0 && musicIndex < musicQueue.length) {
      var track = musicQueue[musicIndex];
      console.warn("Can't play: " + track.title);
    }
    if (musicQueue.length > 1) {
      playNext();
    } else {
      stopPlayback();
    }
  }

  var searchTimeout = null;
  musicSearchInput.addEventListener("input", function () {
    if (searchTimeout) clearTimeout(searchTimeout);
    var q = musicSearchInput.value.trim();
    if (q.length < 2) { musicResults.innerHTML = ""; return; }
    searchTimeout = setTimeout(function () { doMusicSearch(q); }, 300);
  });

  musicPlayBtn.addEventListener("click", togglePlay);
  musicNextBtn.addEventListener("click", playNext);
  musicPrevBtn.addEventListener("click", playPrev);
  musicShuffleBtn.addEventListener("click", toggleShuffle);
  musicRepeatBtn.addEventListener("click", toggleRepeat);
  musicShuffleBtn.classList.toggle("active", musicShuffle);
  musicRepeatBtn.classList.toggle("active", musicRepeat);

  musicToggleBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleMinimize(); });
  document.getElementById("music-header").addEventListener("click", function (e) {
    if (e.target.closest("button")) return;
    if (musicMinimized) toggleMinimize();
  });
  musicSearchToggle.addEventListener("click", function () {
    musicSearchArea.classList.toggle("music-hidden");
    if (!musicSearchArea.classList.contains("music-hidden")) musicSearchInput.focus();
  });

  musicProgressBar.addEventListener("click", function (e) {
    if (!ytPlayer || !ytPlayer.getDuration) return;
    var rect = musicProgressBar.getBoundingClientRect();
    var pct = (e.clientX - rect.left) / rect.width;
    var dur = ytPlayer.getDuration();
    ytPlayer.seekTo(dur * Math.max(0, Math.min(1, pct)));
  });

  musicVolume.addEventListener("input", function () {
    if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(parseInt(musicVolume.value));
  });

  var minimized = musicMinimized;
  musicEl.classList.toggle("music-minimized", minimized);
  if (!minimized) {
    musicToggleIcon.innerHTML = '<polyline points="6 9 12 15 18 9"/>';
    musicToggleBtn.title = "Minimize";
  }

  if (musicIndex >= 0 && musicIndex < musicQueue.length) {
    updateNowPlaying(musicQueue[musicIndex]);
    updateQueueUI();
  }

  loadYouTubeAPI();
})();
