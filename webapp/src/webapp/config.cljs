(ns webapp.config
  (:require ["./version.js" :as version]
            [webapp.env :as env]
            [clojure.string :as cs]))

(def debug?
  ^boolean goog.DEBUG)

(def app-version version)
(println :release env/release-type app-version)

(def release-type env/release-type)

(defn get-api-url []
  (if (cs/blank? env/api-url)
    (let [host (.-host js/location)
          protocol (.-protocol js/location)]
      (str protocol "//" host "/api"))

    env/api-url))

(def api (get-api-url))

(def webapp-url env/webapp-url)
(def lyric-iam-app-url env/hoop-app-url)


(def segment-write-key env/segment-write-key)

(def sentry-sample-rate env/sentry-sample-rate)
(def sentry-dsn env/sentry-dsn)

(def docs-url
  {:concepts {:agents "https://docs.lyric.tech/access/concepts/agents"
              :connections "https://docs.lyric.tech/access/concepts/connections"}
   :features {:runbooks "https://docs.lyric.tech/access/learn/features/runbooks"
              :session-recording "https://docs.lyric.tech/access/learn/features/session-recording"
              :ai-datamasking "https://docs.lyric.tech/access/learn/features/ai-data-masking"
              :ai-session-analyzer "https://docs.lyric.tech/access/learn/features/ai-session-analyzer"
              :attributes "https://docs.lyric.tech/access/learn/features/attributes"
              :access-control "https://docs.lyric.tech/access/learn/features/access-control"
              :reviews "https://docs.lyric.tech/access/learn/features/reviews/overview"
              :jit-reviews "https://docs.lyric.tech/access/learn/features/reviews/jit-reviews"
              :command-reviews "https://docs.lyric.tech/access/learn/features/reviews/command-reviews"
              :guardrails "https://docs.lyric.tech/access/learn/features/guardrails"}
   :introduction {:getting-started "https://docs.lyric.tech/access/introduction/getting-started"}
   :quickstart {:databases "https://docs.lyric.tech/access/quickstart/databases"
                :cloud-services "https://docs.lyric.tech/access/quickstart/cloud-services"
                :web-applications "https://docs.lyric.tech/access/quickstart/web-applications"
                :development-environments "https://docs.lyric.tech/access/quickstart/development-environments"
                :ssh "https://docs.lyric.tech/access/quickstart/ssh"}
   :setup {:architecture "https://docs.lyric.tech/access/setup/architecture"
           :deployment {:overview "https://docs.lyric.tech/access/setup/deployment"
                        :kubernetes "https://docs.lyric.tech/access/setup/deployment/kubernetes"
                        :docker "https://docs.lyric.tech/access/setup/deployment/docker-compose"
                        :aws "https://docs.lyric.tech/access/setup/deployment/AWS"
                        :on-premises "https://docs.lyric.tech/access/setup/deployment/on-premises"}
           :configuration {:overview "https://docs.lyric.tech/access/setup/configuration"
                           :environment-variables "https://docs.lyric.tech/access/setup/configuration/environment-variables"
                           :reverse-proxy "https://docs.lyric.tech/access/setup/configuration/reverse-proxy"
                           :identity-providers "https://docs.lyric.tech/access/setup/configuration/idp/get-started"
                           :secrets-manager "https://docs.lyric.tech/access/setup/configuration/secrets-manager-configuration"
                           :ai-data-masking "https://docs.lyric.tech/access/setup/configuration/ai-data-masking"
                           :rds-iam-auth "https://docs.lyric.tech/access/setup/configuration/rds-iam-auth"}
           :apis {:api-keys "https://docs.lyric.tech/access/setup/apis/api-key#api-key"
                  :overview "https://docs.lyric.tech/access/setup/apis"}
           :license-management "https://docs.lyric.tech/access/setup/license-management"}
   :clients {:web-app {:overview "https://docs.lyric.tech/access/clients/webapp/overview"
                       :creating-connection "https://docs.lyric.tech/access/clients/webapp/creating-connection"
                       :managing-accesss "https://docs.lyric.tech/access/clients/webapp/managing-accesss"
                       :monitoring-sessions "https://docs.lyric.tech/access/clients/webapp/monitoring-sessions"}
             :command-line {:overview "https://docs.lyric.tech/access/clients/cli"
                            :windows "https://docs.lyric.tech/access/clients/cli#windows"
                            :macos "https://docs.lyric.tech/access/clients/cli#mac-os"
                            :linux "https://docs.lyric.tech/access/clients/cli#linux"
                            :managing-configuration "https://docs.lyric.tech/access/clients/cli#managing-configuration"}}
   :integrations {:slack "https://docs.lyric.tech/access/integrations/slack"
                  :teams "https://docs.lyric.tech/access/integrations/teams"
                  :jira "https://docs.lyric.tech/access/integrations/jira"
                  :svix "https://docs.lyric.tech/access/integrations/svix"
                  :aws-connect "https://docs.lyric.tech/access/integrations/aws"}})
