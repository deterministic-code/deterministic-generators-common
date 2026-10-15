using Xunit;
using Xunit.Abstractions;

namespace Deterministic.Generators.Common.Tests;

public class MessageProbeTests(ITestOutputHelper output)
{
    [Fact]
    public async Task PrintMessages()
    {
        var v = new TypesValidator();
        var tags2 = await v.Validate("""
version: 1.0.0
types:
  - base:
      tags: [view_type]
      tags2: [x]
      fields:
        - name:
            type: string
""");
        Dump("tags2", tags2);
        Dump("dict", await v.Validate("version: 1.0.0\ntypes:\n  - settings:\n      inherits: dictionary\n"));
        Dump("valid", await v.Validate("""
version: 1.0.0
types:
  - user:
      fields:
        - email:
            type: string
"""));
        Dump("missing", await v.Validate("types: []\n"));
        Dump("list", await v.Validate("- just a list\n"));
        Dump("bad", await v.Validate("version: latest\ntypes: []\n"));
        Dump("empty", await v.Validate(""));
        var routes = await File.ReadAllTextAsync("/Users/ryan/Projects/deterministic-specifications/examples/errors/routes.bad-method.yaml");
        Dump("routes", await new RoutesValidator().Validate(routes.Split("---", 2)[1]));
        var bindings = await File.ReadAllTextAsync("/Users/ryan/Projects/deterministic-specifications/examples/errors/frontend_bindings.bad-protocol.yaml");
        Dump("bindings", await new FrontendBindingsValidator().Validate(bindings.Split("---", 2)[1]));
        var field = await File.ReadAllTextAsync("/Users/ryan/Projects/deterministic-specifications/examples/errors/types.bad-field-type.yaml");
        Dump("field", await v.Validate(field.Split("---", 2)[1]));
        var ids = await File.ReadAllTextAsync("/Users/ryan/Projects/deterministic-specifications/examples/errors/types.ids-and-is_id.yaml");
        Dump("ids", await v.Validate(ids.Split("---", 2)[1]));
        var app = await File.ReadAllTextAsync("/Users/ryan/Projects/deterministic-specifications/examples/errors/backend_app.apply-and-deny.yaml");
        Dump("app", await new SpecValidator(new SpecRef("backend", "app.spec.yaml")).Validate(app.Split("---", 2)[1]));
        Assert.False(tags2.Valid);
    }

    void Dump(string name, SpecValidationResult result)
    {
        output.WriteLine("==== " + name + " valid=" + result.Valid);
        foreach (var error in result.Errors)
            output.WriteLine(error.InstancePath + " :: " + error.Message);
    }
}
