# Documentación: Rollout Progresivo con ArgoCD y Análisis Automático

Esta guía explica cómo implementar despliegues progresivos (Canary Deployments) usando Argo Rollouts con análisis automático basado en métricas de Prometheus.

---

## 📋 Tabla de Contenidos

1. [Rollout - Despliegue Progresivo](#1-rollout---despliegue-progresivo)
2. [AnalysisTemplate - Validación Automática](#2-analysistemplate---validación-automática)
3. [ServiceMonitor - Recolección de Métricas](#3-servicemonitor---recolección-de-métricas)
4. [Ejemplo Completo Integrado](#4-ejemplo-completo-integrado)

---

## 1. Rollout - Despliegue Progresivo

El **Rollout** es el recurso principal que define cómo se desplegará tu aplicación de manera progresiva. 

### Ejemplo Completo

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-app-rollout
  namespace: production
spec:
  # Número de réplicas totales de tu aplicación
  replicas: 5
  
  # Selector para identificar los pods gestionados por este Rollout
  selector:
    matchLabels:
      app: my-app
      tier: backend
  
  # Template del pod (igual que en un Deployment estándar)
  template:
    metadata:
      labels:
        app: my-app
        tier: backend
        version: v2.1.0
    spec:
      containers:
        - name: api-server
          image: mycompany/my-app:2.1.0
          ports:
            - name: http
              containerPort: 8080
              protocol: TCP
          env:
            - name: ENVIRONMENT
              value: production
            - name: LOG_LEVEL
              value: info
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
  
  # Estrategia de despliegue Canary
  strategy:
    canary:
      # Servicio principal que apunta a la versión estable
      stableService: my-app-stable
      
      # Servicio para el canary (versión nueva en prueba)
      canaryService: my-app-canary
      
      # Pasos del despliegue progresivo
      steps:
        # Paso 1: Enviar 10% del tráfico al canary
        - setWeight: 10
        
        # Paso 2: Pausar 2 minutos para observación
        - pause:
            duration: 2m
        
        # Paso 3: Incrementar al 25%
        - setWeight: 25
        
        # Paso 4: Ejecutar análisis automático
        - analysis:
            templates:
              - templateName: success-rate-check
            args:
              - name: service-name
                value: my-app-canary
        
        # Paso 5: Si el análisis pasa, incrementar al 50%
        - setWeight: 50
        
        # Paso 6: Pausa manual (requiere aprobación)
        - pause: {}
        
        # Paso 7: Incrementar al 75%
        - setWeight: 75
        
        # Paso 8: Último análisis antes del 100%
        - analysis:
            templates:
              - templateName: success-rate-check
              - templateName: latency-check
        
        # Paso 9: Desplegar al 100%
        - setWeight: 100
      
      # Análisis continuo en background durante todo el despliegue
      analysis:
        templates:
          - templateName: error-rate-monitor
        startingStep: 1
        
      # Política de reversión automática
      trafficRouting:
        istio:
          virtualService:
            name: my-app-vsvc
            routes:
              - primary
```

### Explicación de Valores Clave

| Campo | Descripción | Ejemplo |
|-------|-------------|---------|
| `replicas` | Número total de pods | `5` |
| `setWeight` | Porcentaje de tráfico al canary | `10`, `25`, `50`, `100` |
| `pause.duration` | Tiempo de espera automático | `2m`, `30s`, `1h` |
| `pause: {}` | Pausa manual (requiere promoción manual) | Sin duración |
| `analysis.templates` | Referencias a AnalysisTemplates | Lista de nombres |
| `stableService` | Servicio para versión estable | Nombre del Service |
| `canaryService` | Servicio para versión canary | Nombre del Service |

---

## 2. AnalysisTemplate - Validación Automática

El **AnalysisTemplate** define las métricas y condiciones que se deben cumplir para que el despliegue continúe o se revierta automáticamente.

### Ejemplo 1: Verificación de Tasa de Éxito

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate-check
  namespace: production
spec:
  # Argumentos que puede recibir desde el Rollout
  args:
    - name: service-name
      value: my-app-canary  # Valor por defecto
    - name: namespace
      value: production
    - name: minimum-success-rate
      value: "95"  # 95% de éxito mínimo
  
  # Métricas a evaluar
  metrics:
    - name: success-rate
      # Espera inicial antes de comenzar las mediciones
      initialDelay: 60s
      
      # Intervalo entre cada medición
      interval: 30s
      
      # Número de mediciones a realizar
      count: 5
      
      # Cuántos fallos consecutivos antes de abortar
      failureLimit: 2
      
      # Cuántos éxitos consecutivos para considerar exitoso
      consecutiveSuccessfulLimit: 3
      
      # Condición de éxito (expresión CEL)
      successCondition: result[0] >= 95
      
      # Condición de fallo (opcional, complementa successCondition)
      failureCondition: result[0] < 90
      
      # Proveedor de métricas
      provider:
        prometheus:
          address: http://prometheus-server.monitoring.svc:9090
          query: |
            sum(rate(http_requests_total{service="{{args.service-name}}",status=~"2.."}[5m])) 
            / 
            sum(rate(http_requests_total{service="{{args.service-name}}"}[5m])) 
            * 100
```

### Ejemplo 2: Verificación de Latencia

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: latency-check
  namespace: production
spec:
  args:
    - name: service-name
    - name: max-latency-ms
      value: "500"  # Máximo 500ms de latencia p95
  
  metrics:
    - name: p95-latency
      initialDelay: 30s
      interval: 20s
      count: 10
      failureLimit: 3
      successCondition: result[0] <= 500
      provider:
        prometheus:
          address: http://prometheus-server.monitoring.svc:9090
          query: |
            histogram_quantile(0.95, 
              sum(rate(http_request_duration_seconds_bucket{service="{{args.service-name}}"}[5m])) by (le)
            ) * 1000
```

### Ejemplo 3: Verificación de Errores 5xx

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: error-rate-monitor
  namespace: production
spec:
  args:
    - name: service-name
  
  metrics:
    - name: error-5xx-rate
      initialDelay: 10s
      interval: 15s
      # Sin count significa que corre indefinidamente (análisis background)
      failureLimit: 5
      successCondition: result[0] < 1  # Menos del 1% de errores 5xx
      provider:
        prometheus:
          address: http://prometheus-server.monitoring.svc:9090
          query: |
            sum(rate(http_requests_total{service="{{args.service-name}}",status=~"5.."}[2m])) 
            / 
            sum(rate(http_requests_total{service="{{args.service-name}}"}[2m])) 
            * 100
```

### Explicación de Valores Clave

| Campo | Descripción | Ejemplo / Valores |
|-------|-------------|-------------------|
| `initialDelay` | Tiempo de espera antes de comenzar | `30s`, `1m`, `2m` |
| `interval` | Frecuencia de las mediciones | `10s`, `30s`, `1m` |
| `count` | Número de mediciones (omitir para continuo) | `5`, `10`, omitido |
| `failureLimit` | Fallos consecutivos para abortar | `2`, `3`, `5` |
| `consecutiveSuccessfulLimit` | Éxitos consecutivos requeridos | `3`, `5` |
| `successCondition` | Expresión CEL para éxito | `result[0] >= 95` |
| `failureCondition` | Expresión CEL para fallo | `result[0] < 90` |
| `prometheus.address` | URL del servidor Prometheus | `http://prometheus:9090` |
| `prometheus.query` | Query PromQL | Ver ejemplos arriba |

### Expresiones CEL Comunes

```yaml
# Verificar que hay resultados y son mayores a 95
successCondition: len(result) > 0 && result[0] >= 95

# Verificar que el valor está entre 90 y 100
successCondition: result[0] >= 90 && result[0] <= 100

# Verificar múltiples condiciones
successCondition: result[0] > 95 && result[1] < 500

# Verificar que NO hay errores
successCondition: isNaN(result[0]) || result[0] == 0
```

---

## 3. ServiceMonitor - Recolección de Métricas

El **ServiceMonitor** (parte del Prometheus Operator) define cómo Prometheus debe recolectar métricas de tu aplicación.

### Ejemplo Completo

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-app-metrics
  namespace: production
  labels:
    # Label que Prometheus usa para descubrir este ServiceMonitor
    app: my-app
    team: backend
    # IMPORTANTE: Prometheus busca este label para saber qué ServiceMonitors usar
    release: prometheus-operator
spec:
  # Selector para encontrar el Service que expone las métricas
  selector:
    matchLabels:
      app: my-app
      metrics: enabled
  
  # Namespaces donde buscar los Services
  namespaceSelector:
    matchNames:
      - production
      - staging
    # Alternativa: cualquier namespace
    # any: true
  
  # Configuración de los endpoints de métricas
  endpoints:
    # Puerto del Service a scrapear (por nombre)
    - port: http-metrics
      
      # Path donde están expuestas las métricas
      path: /metrics
      
      # Frecuencia de recolección
      interval: 30s
      
      # Timeout para cada scrape
      scrapeTimeout: 10s
      
      # Esquema de conexión
      scheme: http  # o https
      
      # Mantener labels originales del target
      honorLabels: true
      
      # Labels adicionales a agregar
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_name]
          targetLabel: pod
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
      
      # Transformación de métricas
      metricRelabelings:
        - sourceLabels: [__name__]
          regex: 'go_.*'
          action: drop  # Eliminar métricas de Go runtime
    
    # Segundo endpoint para métricas de negocio
    - port: business-metrics
      path: /business/metrics
      interval: 60s
      scrapeTimeout: 15s
```

### Ejemplo con Autenticación TLS

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-secure-app-metrics
  namespace: production
spec:
  selector:
    matchLabels:
      app: my-secure-app
  endpoints:
    - port: https-metrics
      path: /metrics
      interval: 30s
      scheme: https
      
      # Configuración TLS
      tlsConfig:
        # Validar certificado del servidor
        insecureSkipVerify: false
        
        # CA para validar el certificado
        ca:
          secret:
            name: prometheus-ca-cert
            key: ca.crt
        
        # Certificado de cliente para mTLS
        cert:
          secret:
            name: prometheus-client-cert
            key: tls.crt
        
        # Llave privada del cliente
        keySecret:
          name: prometheus-client-cert
          key: tls.key
        
        # Nombre del servidor para SNI
        serverName: my-secure-app.production.svc.cluster.local
      
      # Bearer token para autenticación
      bearerTokenSecret:
        name: prometheus-token
        key: token
```

### Explicación de Valores Clave

| Campo | Descripción | Ejemplo / Valores |
|-------|-------------|-------------------|
| `selector.matchLabels` | Labels del Service a monitorear | `app: my-app` |
| `namespaceSelector` | Namespaces donde buscar Services | `matchNames: [prod]` |
| `endpoints[].port` | Nombre del puerto del Service | `http-metrics`, `http` |
| `endpoints[].path` | Path de las métricas | `/metrics`, `/actuator/prometheus` |
| `endpoints[].interval` | Frecuencia de scraping | `15s`, `30s`, `1m` |
| `endpoints[].scrapeTimeout` | Timeout por scrape | `10s`, `15s` |
| `endpoints[].scheme` | Protocolo | `http`, `https` |
| `endpoints[].honorLabels` | Mantener labels del target | `true`, `false` |
| `labels.release` | Release de Prometheus Operator | `prometheus-operator`, `kube-prometheus-stack` |

### Service Correspondiente

El ServiceMonitor busca un Service con las labels correspondientes:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app-metrics
  namespace: production
  labels:
    app: my-app
    metrics: enabled
spec:
  selector:
    app: my-app
  ports:
    - name: http-metrics  # Nombre usado en ServiceMonitor
      port: 8080
      targetPort: 8080
      protocol: TCP
  type: ClusterIP
```

---

## 4. Ejemplo Completo Integrado

### Paso 1: Service para Versión Estable

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app-stable
  namespace: production
  labels:
    app: my-app
    version: stable
spec:
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 8080
```

### Paso 2: Service para Canary

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app-canary
  namespace: production
  labels:
    app: my-app
    version: canary
spec:
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 8080
```

### Paso 3: ServiceMonitor

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-app-monitor
  namespace: production
  labels:
    app: my-app
    release: prometheus-operator
spec:
  selector:
    matchLabels:
      app: my-app
  namespaceSelector:
    matchNames:
      - production
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
      scrapeTimeout: 10s
```

### Paso 4: AnalysisTemplate

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: comprehensive-health-check
  namespace: production
spec:
  args:
    - name: canary-hash
  
  metrics:
    - name: success-rate
      initialDelay: 60s
      interval: 30s
      count: 6
      failureLimit: 2
      successCondition: result[0] >= 99
      provider:
        prometheus:
          address: http://prometheus-server.monitoring.svc:9090
          query: |
            sum(rate(http_requests_total{
              pod_template_hash="{{args.canary-hash}}",
              status=~"2.."
            }[5m])) 
            / 
            sum(rate(http_requests_total{
              pod_template_hash="{{args.canary-hash}}"
            }[5m])) 
            * 100
    
    - name: error-rate
      interval: 20s
      count: 5
      failureLimit: 3
      successCondition: result[0] < 0.5
      provider:
        prometheus:
          address: http://prometheus-server.monitoring.svc:9090
          query: |
            sum(rate(http_requests_total{
              pod_template_hash="{{args.canary-hash}}",
              status=~"5.."
            }[3m])) 
            / 
            sum(rate(http_requests_total{
              pod_template_hash="{{args.canary-hash}}"
            }[3m])) 
            * 100
```

### Paso 5: Rollout

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-app-rollout
  namespace: production
spec:
  replicas: 10
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "8080"
        prometheus.io/path: "/metrics"
    spec:
      containers:
        - name: app
          image: mycompany/my-app:3.0.0
          ports:
            - name: http
              containerPort: 8080
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 30
          readinessProbe:
            httpGet:
              path: /ready
              port: 8080
            initialDelaySeconds: 10
  
  strategy:
    canary:
      stableService: my-app-stable
      canaryService: my-app-canary
      
      steps:
        - setWeight: 10
        - pause: {duration: 1m}
        
        - setWeight: 25
        - analysis:
            templates:
              - templateName: comprehensive-health-check
            args:
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest
        
        - setWeight: 50
        - pause: {duration: 2m}
        
        - setWeight: 75
        - analysis:
            templates:
              - templateName: comprehensive-health-check
            args:
              - name: canary-hash
                valueFrom:
                  podTemplateHashValue: Latest
        
        - setWeight: 100
      
      # Análisis continuo durante todo el despliegue
      analysis:
        templates:
          - templateName: comprehensive-health-check
        startingStep: 1
        args:
          - name: canary-hash
            valueFrom:
              podTemplateHashValue: Latest
```

---

## 📊 Flujo de Trabajo Completo

```
1. Desplegar nueva versión
   ↓
2. Crear pods canary (10% tráfico)
   ↓
3. ServiceMonitor recolecta métricas
   ↓
4. Prometheus almacena métricas
   ↓
5. AnalysisTemplate consulta Prometheus
   ↓
6. ¿Métricas OK?
   ├─ SÍ → Continuar al siguiente paso
   └─ NO → Rollback automático
   ↓
7. Incrementar tráfico (25%, 50%, 75%)
   ↓
8. Repetir análisis en cada paso
   ↓
9. Despliegue completo al 100%
```

---

## 🎯 Mejores Prácticas

### 1. **Análisis en Múltiples Etapas**
```yaml
steps:
  - setWeight: 10
  - analysis:  # Análisis inicial rápido
      templates:
        - templateName: quick-health-check
  - setWeight: 50
  - analysis:  # Análisis más profundo
      templates:
        - templateName: comprehensive-check
        - templateName: performance-check
```

### 2. **Argumentos Dinámicos**
```yaml
analysis:
  args:
    - name: canary-hash
      valueFrom:
        podTemplateHashValue: Latest  # Hash del canary actual
    - name: stable-hash
      valueFrom:
        podTemplateHashValue: Stable  # Hash de la versión estable
```

### 3. **Análisis Comparativo Canary vs Stable**
```yaml
metrics:
  - name: canary-vs-stable-error-rate
    successCondition: result[0] <= result[1] * 1.1  # Canary no más de 10% peor que stable
    provider:
      prometheus:
        query: |
          (
            sum(rate(http_requests_total{pod_template_hash="{{args.canary-hash}}",status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{pod_template_hash="{{args.canary-hash}}"}[5m]))
          )
          /
          (
            sum(rate(http_requests_total{pod_template_hash="{{args.stable-hash}}",status=~"5.."}[5m]))
            /
            sum(rate(http_requests_total{pod_template_hash="{{args.stable-hash}}"}[5m]))
          )
```

### 4. **Múltiples ServiceMonitor Endpoints**
```yaml
endpoints:
  - port: http
    path: /metrics        # Métricas generales
  - port: http
    path: /business/metrics  # Métricas de negocio
  - port: http
    path: /jvm/metrics    # Métricas JVM
```

---

## 🔧 Comandos Útiles

```bash
# Ver estado del rollout
kubectl argo rollouts get rollout my-app-rollout -n production

# Promover manualmente el canary
kubectl argo rollouts promote my-app-rollout -n production

# Abortar el rollout
kubectl argo rollouts abort my-app-rollout -n production

# Ver análisis en ejecución
kubectl get analysisrun -n production

# Ver logs del análisis
kubectl logs -l analysisrun=my-app-rollout-xyz -n production

# Ver métricas recolectadas por ServiceMonitor
kubectl get servicemonitor -n production
kubectl describe servicemonitor my-app-monitor -n production
```

---

**Documento creado para facilitar la implementación de despliegues progresivos con ArgoCD** 🚀
