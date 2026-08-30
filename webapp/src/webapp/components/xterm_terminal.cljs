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
   [clojure.string :as string]
   [reagent.core :as r]))

;; xterm is vendored as a plain <script> global (see index.html): the npm
;; bundle trips shadow-cljs's Closure conversion, so we read the UMD globals.
(defn- terminal-ctor [] (.-Terminal js/window))
(defn- fit-ctor [] (some-> (.-FitAddon js/window) .-FitAddon))

(defn available?
  "True when the vendored xterm bundle actually loaded. Callers render a
  plain ANSI <pre> instead when it didn't, rather than a dead black box."
  []
  (some? (terminal-ctor)))

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
        ;; The exact text already written to the emulator, so an update can
        ;; tell "the tail grew" (write the suffix) from "the stream was
        ;; replaced" (reset and rewrite). The parent already holds this
        ;; string, so keeping the reference costs nothing.
        written (atom "")
        write-text!
        (fn [text]
          (when-let [^js t @term]
            (let [text (or text "")
                  prev @written]
              (when-not (= text prev)
                (if (string/starts-with? text prev)
                  (.write t (subs text (count prev)))
                  (do (.reset t)
                      (.write t text)))
                (reset! written text)))))
        fit!
        (fn []
          (when-let [^js fit @fit-addon]
            ;; xterm throws if it is asked to measure a detached/zero-sized
            ;; node — a resize observed mid-unmount, for instance.
            (try (.fit fit) (catch :default _ nil))))]
    (r/create-class
     {:display-name "xterm-terminal"

      :component-did-mount
      (fn [this]
        ;; Bind the constructors to locals before `new`: ClojureScript
        ;; compiles `(new (ctor-expr) args)` to `new f()(args)`, which JS
        ;; parses as `(new f())(args)` — the class ends up *called* rather
        ;; than constructed ("Class constructor cannot be invoked without
        ;; 'new'"). A plain symbol emits the `new` correctly.
        (let [term-class (terminal-ctor)
              fit-class (fit-ctor)]
          (when (and term-class @container)
            (let [^js t (new term-class terminal-options)]
              (reset! term t)
              (when fit-class
                (let [^js fit (new fit-class)]
                  (reset! fit-addon fit)
                  (.loadAddon t fit)))
              (.open t @container)
              (fit!)
              (let [obs (js/ResizeObserver. fit!)]
                (reset! resize-observer obs)
                (.observe obs @container))
              (write-text! (:text (r/props this)))))))

      :component-did-update
      (fn [this _]
        (write-text! (:text (r/props this))))

      :component-will-unmount
      (fn [_]
        (when-let [^js obs @resize-observer] (.disconnect obs))
        (when-let [^js t @term] (.dispose t))
        (reset! resize-observer nil)
        (reset! term nil)
        (reset! fit-addon nil)
        (reset! written ""))

      :reagent-render
      (fn [_]
        [:div {:ref #(reset! container %)
               :class "h-[55vh] min-h-[200px] bg-[#111827] p-2"}])})))
