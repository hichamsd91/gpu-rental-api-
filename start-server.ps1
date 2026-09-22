# GPU Rental Platform - PowerShell HTTP Server
# يعمل بدون Node.js

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:5000/")
$listener.Start()
Write-Host "Server running at http://localhost:5000" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow

$routes = @{
    "GET /health" = { @{success=$true; timestamp=(Get-Date -Format "o")} | ConvertTo-Json }
    "POST /api/auth/register" = { 
        param($body)
        if (-not $body.email -or -not $body.password -or -not $body.fullName) {
            return @{success=$false; message="Missing required fields"} | ConvertTo-Json
        }
        return @{success=$true; message="Registered"; user=@{email=$body.email; fullName=$body.fullName; role=$body.role}} | ConvertTo-Json
    }
    "POST /api/auth/login" = {
        param($body)
        if (-not $body.email -or -not $body.password) {
            return @{success=$false; message="Missing credentials"} | ConvertTo-Json
        }
        return @{success=$true; message="Logged in"; token="demo-token"; user=@{id="1"; email=$body.email; fullName="Demo"; role="renter"}} | ConvertTo-Json
    }
    "GET /api/auth/me" = { @{success=$true; user=@{id="1"; email="demo@test.com"; fullName="Demo"; role="renter"}} | ConvertTo-Json }
    "GET /api/listings" = { @{success=$true; listings=@()} | ConvertTo-Json }
    "GET /api/rentals" = { @{success=$true; rentals=@()} | ConvertTo-Json }
    "GET /api/devices" = { @{success=$true; devices=@()} | ConvertTo-Json }
    "GET /api/gpus" = { @{success=$true; gpus=@()} | ConvertTo-Json }
    "GET /api/admin/stats" = { @{success=$true; stats=@{users=0; gpus=0; rentals=0; revenue=0}} | ConvertTo-Json }
    "GET /api/signaling/info" = {
        @{
            success=$true
            signaling=@{
                url="http://localhost:5000"
                stunServers=@(
                    @{urls="stun:stun.l.google.com:19302"}
                    @{urls="stun:stun1.l.google.com:19302"}
                )
            }
        } | ConvertTo-Json
    }
}

while ($true) {
    try {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        
        $method = $req.HttpMethod
        $path = $req.Url.AbsolutePath
        
        # CORS headers
        $res.Headers.Add("Access-Control-Allow-Origin", "*")
        $res.Headers.Add("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
        $res.Headers.Add("Access-Control-Allow-Headers", "Content-Type,Authorization")
        $res.ContentType = "application/json; charset=utf-8"
        
        if ($method -eq "OPTIONS") {
            $res.StatusCode = 200
            $res.Close()
            continue
        }
        
        $routeKey = "$method $path"
        
        if ($method -eq "POST") {
            $reader = New-Object System.IO.StreamReader($req.InputStream)
            $bodyText = $reader.ReadToEnd()
            $reader.Close()
            try {
                $body = $bodyText | ConvertFrom-Json
            } catch {
                $body = @{}
            }
        } else {
            $body = @{}
        }
        
        if ($routes.ContainsKey($routeKey)) {
            $result = & $routes[$routeKey] $body
            $res.StatusCode = 200
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($result)
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        } else {
            $res.StatusCode = 404
            $result = @{success=$false; message="Not found"} | ConvertTo-Json
            $buffer = [System.Text.Encoding]::UTF8.GetBytes($result)
            $res.OutputStream.Write($buffer, 0, $buffer.Length)
        }
        
        $res.Close()
    } catch {
        Write-Host "Error: $_" -ForegroundColor Red
    }
}
