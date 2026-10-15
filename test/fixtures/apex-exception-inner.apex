class Helper {
    void boom() {
        System.debug(JSON.serializePretty(new Map<String, Object>{ 'a' => 1, 'b' => 'two' }));
        throw new IllegalArgumentException('bad thing');
    }
}
System.debug('start');
new Helper().boom();
