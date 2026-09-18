Option Explicit

Dim fso, shell, appDir, nodePath, chromePath, serverPath, appPort, appVersion, url, ready, attempt
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = ResolveOnPath("node.exe", shell, fso)
chromePath = FindChrome(shell, fso)

If nodePath = "" Then
  MsgBox "Node.js was not found. Please install Node.js and try again.", 48, "Multi-package email tool"
  WScript.Quit 1
End If

If chromePath = "" Then
  MsgBox "Google Chrome was not found. Please install Chrome and try again.", 48, "Multi-package email tool"
  WScript.Quit 1
End If

serverPath = fso.BuildPath(appDir, "server.mjs")
appPort = "8788"
appVersion = "20260909-copy-order-feedback"
shell.Environment("Process")("PORT") = appPort
url = "http://127.0.0.1:" & appPort
shell.CurrentDirectory = appDir

If Not IsReady(url, appVersion) Then
  StopExistingServer appPort, shell
  WScript.Sleep 500
  shell.Run Quote(nodePath) & " " & Quote(serverPath) & " --port " & appPort, 0, False
End If

ready = False
For attempt = 1 To 30
  WScript.Sleep 1000
  If IsReady(url, appVersion) Then
    ready = True
    Exit For
  End If
Next

If Not ready Then
  MsgBox "The local service did not become ready within 30 seconds.", 48, "Multi-package email tool"
  WScript.Quit 1
End If

shell.Run Quote(chromePath) & " --new-window " & Quote(url & "?v=" & appVersion), 1, False

Function ResolveOnPath(fileName, shellObject, fileSystem)
  Dim pathValue, pathParts, part, candidate
  pathValue = shellObject.ExpandEnvironmentStrings("%PATH%")
  pathParts = Split(pathValue, ";")
  For Each part In pathParts
    If Trim(part) <> "" Then
      candidate = fileSystem.BuildPath(Trim(part), fileName)
      If fileSystem.FileExists(candidate) Then
        ResolveOnPath = candidate
        Exit Function
      End If
    End If
  Next
  ResolveOnPath = ""
End Function

Function FindChrome(shellObject, fileSystem)
  Dim candidates, candidate, index
  candidates = Array( _
    shellObject.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe"), _
    shellObject.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"), _
    shellObject.ExpandEnvironmentStrings("%LocalAppData%\Google\Chrome\Application\chrome.exe") _
  )
  For index = 0 To UBound(candidates)
    candidate = candidates(index)
    If fileSystem.FileExists(candidate) Then
      FindChrome = candidate
      Exit Function
    End If
  Next
  FindChrome = ResolveOnPath("chrome.exe", shellObject, fileSystem)
End Function

Sub StopExistingServer(port, shellObject)
  Dim command, exec, line, fields, processId
  command = "cmd /c netstat -ano -p tcp"
  Set exec = shellObject.Exec(command)
  Do While Not exec.StdOut.AtEndOfStream
    line = Trim(exec.StdOut.ReadLine)
    If InStr(1, line, "127.0.0.1:" & port, vbTextCompare) > 0 _
      And InStr(1, line, "LISTENING", vbTextCompare) > 0 Then
      fields = Split(line)
      processId = fields(UBound(fields))
      If IsNumeric(processId) Then
        shellObject.Run "taskkill /PID " & processId & " /T /F", 0, True
      End If
    End If
  Loop
End Sub

Function IsReady(endpoint, expectedVersion)
  Dim request
  On Error Resume Next
  Set request = CreateObject("MSXML2.XMLHTTP")
  request.Open "GET", endpoint & "/api/health", False
  request.Send
  IsReady = (Err.Number = 0 And request.Status = 200 _
    And InStr(1, request.ResponseText, """version"":""" & expectedVersion & """", vbTextCompare) > 0)
  Err.Clear
  On Error GoTo 0
End Function

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
