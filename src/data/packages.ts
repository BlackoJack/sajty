import defaults from "../../yandex/lead/content.default.json";

const nums = ["01", "02", "03"] as const;

export const packages = defaults.packages.map((pkg, index) => ({
  id: pkg.id,
  num: nums[index] ?? "00",
  name: pkg.name,
  price: defaults.price[pkg.id as keyof typeof defaults.price],
  tagline: pkg.tagline,
  bestFor: pkg.bestFor,
  items: pkg.items,
}));
