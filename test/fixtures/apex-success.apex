// Ctrl+S runs this in devSandbox. Close the tab to discard.
Integer x = 41;
System.debug('hello ' + (x + 1));
List<Account> a = [SELECT Id, Name FROM Account LIMIT 3];
System.debug(LoggingLevel.WARN, a.size());
System.debug('multi\nline\nmsg');
Map<String, Object> m = new Map<String, Object>{ 'k' => null, 'n' => 5, 'b' => true };
System.debug(m);
System.debug(a);
System.debug(LoggingLevel.ERROR, 'err level');
System.debug(LoggingLevel.INFO, 'info level');
System.debug(LoggingLevel.FINE, 'fine level');
