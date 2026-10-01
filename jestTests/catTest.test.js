const CatFact = require("./catFact");

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test("test cat facts", async () => {
  const catFactInstance = new CatFact();
  expect(catFactInstance.history()).toHaveLength(0);

  // --- SUCCESS SCENARIO ---
  const fakeFact = "Cats have 230 bones.";
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => ({ data: [fakeFact] }),
  });

  const callbackSpy = jest.fn();

  catFactInstance.call(5000, callbackSpy);

  await jest.advanceTimersByTimeAsync(5000);

  expect(callbackSpy).toHaveBeenCalledWith(fakeFact);
  expect(catFactInstance.history()).toHaveLength(1);
  expect(catFactInstance.history()[0]).toBe(fakeFact);

  // --- FAILURE SCENARIO ---
  global.fetch = jest.fn().mockRejectedValue(new Error("Network Failure"));
  catFactInstance.call(5000, callbackSpy);
  await jest.advanceTimersByTimeAsync(5000);

  expect(callbackSpy).toHaveBeenCalledWith(null);
  expect(catFactInstance.history()).toHaveLength(1);
});
