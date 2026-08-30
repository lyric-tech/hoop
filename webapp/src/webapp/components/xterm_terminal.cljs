(ns webapp.components.xterm-terminal
  "Read-only streaming terminal built on xterm.js. Renders a growing PTY
  output string with real VT semantics (cursor movement, colors, TUI apps),
  replacing the ANSI-to-HTML <pre> that degraded on anything interactive.

  Writes are append-only: each update writes just the new suffix of :text.
  If the text no longer extends what was already written (stream replaced),
  the terminal resets and rewrites from scratch. xterm follows the tail
  natively while the viewport sits at the bottom, so 'scroll up to inspect'
  keeps working with zero extra code.

  ghostty-web mirrors this exact API, so swapping emulators later is an
  import change."
  (:require
   [reagent.core :as r]))

;; xterm is vendored as a plain <script> global (see index.html): the npm
;; bundle trips shadow-cljs's Closure conversion, so we read the UMD globals.
(defn- terminal-ctor [] (.-Terminal js/window))
(defn- fit-ctor [] (some-> (.-FitAddon js/window) .-FitAddon))

(def ^:private terminal-options
  #js {:disableStdin true
       :cursorBlink false
       :convertEol false
       :fontSize 13
       :fontFamily "ui-monospace, SFMono-Regular, Menlo, monospace"
       :scrollback 10000
       :theme #js {:background "#111827" ;; matches the old bg-gray-900 block
                   :foreground "#e5e7eb"}})

(defn main [_]
  (let [container (atom nil)
        term (atom nil)
        fit-addon (atom nil)
        resize-observer (atom nil)
        written (atom 0)
        write-text!
        (fn [text]
          (when-let [^js t @term]
            (let [text (or text "")
                  n @written]
              (if (and (<= n (count text))
                       (pos? n))
                (when (> (count text) n)
                  (.write t (subs text n)))
                (do (.reset t)
                    (.write t text)))
              (reset! written (count text)))))]
    (r/create-class
     {:display-name "xterm-terminal"

      :component-did-mount
      (fn [this]
        (let [^js t (new (terminal-ctor) terminal-options)
              ^js fit (new (fit-ctor))]
          (reset! term t)
          (reset! fit-addon fit)
          (.loadAddon t fit)
          (.open t @container)
          (.fit fit)
          (let [obs (js/ResizeObserver. (fn [_] (when @fit-addon (.fit ^js @fit-addon))))]
            (reset! resize-observer obs)
            (.observe obs @container))
          (write-text! (:text (r/props this)))))

      :component-did-update
      (fn [this _]
        (write-text! (:text (r/props this))))

      :component-will-unmount
      (fn [_]
        (when-let [^js obs @resize-observer] (.disconnect obs))
        (when-let [^js t @term] (.dispose t))
        (reset! term nil)
        (reset! fit-addon nil))

      :reagent-render
      (fn [_]
        [:div {:ref #(reset! container %)
               :class "h-[55vh] min-h-[200px] bg-[#111827] p-2"}])})))
