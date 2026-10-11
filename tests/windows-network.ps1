param([string]$Origin = 'http://127.0.0.1:3003')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$gptCookies = [System.Net.CookieContainer]::new()
$gptHandler = [System.Net.Http.HttpClientHandler]::new()
$gptHandler.UseProxy = $false
$gptHandler.CookieContainer = $gptCookies
$gptHttp = [System.Net.Http.HttpClient]::new($gptHandler)
$gptHttp.Timeout = [TimeSpan]::FromSeconds(10)
$gptClock = [System.Diagnostics.Stopwatch]::StartNew()
$gptResponse = $gptHttp.GetAsync("$Origin/").GetAwaiter().GetResult()
[void]$gptResponse.EnsureSuccessStatusCode()
$gptHandshake = $gptClock.Elapsed.TotalMilliseconds
$gptWs = [System.Net.WebSockets.ClientWebSocket]::new()
$gptWs.Options.Cookies = $gptCookies
$gptWs.Options.SetRequestHeader('Origin', $Origin)
$gptCancellation = [Threading.CancellationTokenSource]::new(45000)
$gptBuffer = [byte[]]::new(131072)
$gptFrames = 0
$gptCapture = $null
function Send-GptPacket($Message) {
    $gptBytes = [Text.Encoding]::UTF8.GetBytes(($Message | ConvertTo-Json -Compress))
    $gptSegment = [ArraySegment[byte]]::new($gptBytes)
    [void]$gptWs.SendAsync($gptSegment, [Net.WebSockets.WebSocketMessageType]::Text, $true, $gptCancellation.Token).GetAwaiter().GetResult()
}
function Read-GptMessage {
    while ($true) {
        $gptStream = [IO.MemoryStream]::new()
        do {
            $gptReceived = $gptWs.ReceiveAsync([ArraySegment[byte]]::new($gptBuffer), $gptCancellation.Token).GetAwaiter().GetResult()
            if ($gptReceived.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { throw 'WebSocket closed during diagnostics' }
            $gptStream.Write($gptBuffer, 0, $gptReceived.Count)
        } while (-not $gptReceived.EndOfMessage)
        $gptBytes = $gptStream.ToArray()
        $gptStream.Dispose()
        if ($gptReceived.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Binary) {
            if ($gptBytes.Length -lt 32) { throw 'Invalid frame' }
            $script:gptFrames++
            $script:gptCapture = @{
                width = [BitConverter]::ToUInt16($gptBytes, 8)
                height = [BitConverter]::ToUInt16($gptBytes, 10)
                copyMs = [BitConverter]::ToUInt32($gptBytes, 24) / 1000.0
                encodeMs = [BitConverter]::ToUInt32($gptBytes, 28) / 1000.0
                bytes = $gptBytes.Length
            }
            Send-GptPacket @{type='frameAck'; sequence=[BitConverter]::ToUInt32($gptBytes, 4)}
        } else {
            return [Text.Encoding]::UTF8.GetString($gptBytes) | ConvertFrom-Json
        }
    }
}
try {
    $gptWsUri = [Uri](($Origin -replace '^http:', 'ws:' -replace '^https:', 'wss:') + '/ws?tab=' + [Guid]::NewGuid().ToString())
    [void]$gptWs.ConnectAsync($gptWsUri, $gptCancellation.Token).GetAwaiter().GetResult()
    do { $gptMessage = Read-GptMessage; if ($gptMessage.type -eq 'fatal') { throw $gptMessage.message } } while ($gptMessage.type -ne 'ready')
    Send-GptPacket @{type='viewport'; width=3840; height=2160; deviceScaleFactor=1}
    for ($gptWarm=0; $gptWarm -lt 50; $gptWarm++) {
        Send-GptPacket @{type='diagnostic-ping'; probeId="warm-$gptWarm"}
        do { $gptMessage = Read-GptMessage } while ($gptMessage.type -ne 'diagnostic-pong' -or $gptMessage.probeId -ne "warm-$gptWarm")
        if ($gptCapture -and $gptCapture.width -eq 3840) { break }
        Start-Sleep -Milliseconds 50
    }
    $gptSamples = [Collections.Generic.List[double]]::new()
    for ($gptIndex=0; $gptIndex -lt 35; $gptIndex++) {
        $gptClock.Restart()
        Send-GptPacket @{type='diagnostic-ping'; probeId="$gptIndex"}
        do { $gptMessage = Read-GptMessage } while ($gptMessage.type -ne 'diagnostic-pong' -or $gptMessage.probeId -ne "$gptIndex")
        if ($gptIndex -ge 5) { $gptSamples.Add($gptClock.Elapsed.TotalMilliseconds) }
    }
    $gptSorted = @($gptSamples | Sort-Object)
    @{
        origin=$Origin; httpHandshakeMs=[Math]::Round($gptHandshake,2)
        websocketRttMs=@{median=[Math]::Round($gptSorted[15],2); p95=[Math]::Round($gptSorted[28],2); min=[Math]::Round($gptSorted[0],2); max=[Math]::Round($gptSorted[29],2)}
        framesReceived=$gptFrames; capture=$gptCapture
        method='Windows to server application WebSocket round trip; not input-to-display latency'
    } | ConvertTo-Json -Compress -Depth 4
} finally {
    $gptWs.Abort(); $gptWs.Dispose(); $gptCancellation.Dispose(); $gptResponse.Dispose(); $gptHttp.Dispose(); $gptHandler.Dispose()
}
