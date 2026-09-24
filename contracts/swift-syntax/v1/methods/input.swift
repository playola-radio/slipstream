struct Counter {
    var count: Int
    func increment() -> Int { count + 1 }
    mutating func reset() { count = 0 }
}
