"""KQL used by the Log Analytics collector. {start}/{end} are ISO timestamps."""

INFERENCE = """
AzureDiagnostics
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where ResourceProvider == "MICROSOFT.COGNITIVESERVICES" and Category in ("RequestResponse", "AzureOpenAIRequestUsage", "Audit")
| extend p = parse_json(properties_s)
// AzureOpenAIRequestUsage reports token counts as arrays ([n]); RequestResponse reports scalars.
| project TimeGenerated, ResourceId = _ResourceId, Resource, Category, OperationName, ResultSignature, DurationMs,
    CallerIPAddress, CorrelationId, objectId = tostring(p.objectId), callerObjectId = tostring(p.callerObjectId),
    apiName = tostring(p.apiName), deployment = tostring(p.modelDeploymentName), model = tostring(p.modelName),
    promptTokens = coalesce(toint(p.promptTokens), toint(p.promptTokens[0])),
    completionTokens = coalesce(toint(p.completionTokens), toint(p.generatedTokens[0])),
    cachedTokens = toint(p.cachedTokens[0]), streamType = tostring(p.streamType), requestLength = tolong(p.requestLength),
    responseLength = tolong(p.responseLength)
| order by TimeGenerated asc
| take 20000
"""

# Server-side Foundry agent traces and Copilot Studio environment-level traces (OTel GenAI spans).
GENAI_SPANS = """
let spans = AppDependencies
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where isnotempty(Properties["gen_ai.operation.name"]) or Name in ("InvokeAgent", "ExecuteTool", "OutputMessages")
| project TimeGenerated, SpanId = Id, TraceId = OperationId, ParentId, Name, Success, ResultCode, DurationMs, AppRoleName,
    _ResourceId, Properties;
let content = AppGenAIContent
| where TimeGenerated between (datetime({start}) - 10m .. datetime({end}) + 10m)
| project SpanId, InputMessages, OutputMessages, SystemInstructions, ToolDefinitions, ToolCallArguments, ToolCallResult;
spans
| join kind=leftouter content on SpanId
| order by TimeGenerated asc
| take 20000
"""

# Copilot Studio agent-level Application Insights telemetry (customEvents).
CS_EVENTS = """
AppEvents
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where Name in ("BotMessageReceived", "BotMessageSend", "TopicStart", "TopicAction", "TopicEnd", "GenerativeAnswers", "OnErrorLog")
    or isnotempty(Properties["conversationId"])
| project TimeGenerated, Name, Properties, SessionId, UserId, AppRoleName, _ResourceId
| order by TimeGenerated asc
| take 20000
"""

ACTIVITY = """
AzureActivity
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where ResourceProviderValue in~ ("MICROSOFT.COGNITIVESERVICES", "MICROSOFT.MACHINELEARNINGSERVICES", "MICROSOFT.AUTHORIZATION",
    "MICROSOFT.KEYVAULT", "MICROSOFT.INSIGHTS", "MICROSOFT.POWERPLATFORM", "MICROSOFT.BOTSERVICE",
    "MICROSOFT.OPERATIONALINSIGHTS", "MICROSOFT.APIMANAGEMENT")
| where ActivityStatusValue in~ ("Success", "Succeeded", "Failure", "Failed") and CategoryValue == "Administrative"
| project TimeGenerated, OperationNameValue, ActivityStatusValue, Caller, CallerIpAddress, ResourceId = _ResourceId,
    CorrelationId, Claims_d = Claims, Properties_d = Properties
| order by TimeGenerated asc
| take 5000
"""

NETWORK = """
NTANetAnalytics
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where SubType == "FlowLog" and FlowType in ("ExternalPublic", "MaliciousFlow", "AzurePublic", "UnknownPrivate", "Unknown")
// Public endpoints are carried in Src/DestPublicIps ("ip|counters ...") rather than Src/DestIp.
| extend Src = iff(isempty(SrcIp), extract(@"(\\d+\\.\\d+\\.\\d+\\.\\d+)", 1, tostring(SrcPublicIps)), SrcIp),
    Dst = iff(isempty(DestIp), extract(@"(\\d+\\.\\d+\\.\\d+\\.\\d+)", 1, tostring(DestPublicIps)), DestIp)
| summarize TimeGenerated = min(TimeGenerated), Bytes = sum(BytesSrcToDest), Flows = count(), Statuses = make_set(FlowStatus, 4)
    by SrcIp = Src, DestIp = Dst, DestPort, L7Protocol, FlowType, FlowDirection, SrcSubnet, DestSubnet, TargetResourceId, Country
| take 5000
"""

DEFENDER = """
SecurityAlert
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where AlertType startswith "AI."
| project TimeGenerated, AlertName, AlertType, AlertSeverity, Description, CompromisedEntity, ExtendedProperties, Entities,
    SystemAlertId, ResourceId = AzureResourceId
| take 1000
"""
